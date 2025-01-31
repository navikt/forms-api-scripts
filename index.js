import pg from 'pg'
import pgFormat from 'pg-format'
import config from './src/config.js'
import logger from './src/logger.js'
import formioApi from './src/formio-api.js'
import summary from "./src/summary.js";

const {Pool} = pg;

const {
  dryRun,
  formioBaseUrl,
  maxLengthTranslation,
} = config;

if (!formioBaseUrl) {
  throw new Error(`FORMIO_BASE_URL environment variable is not set`);
}

let globalTranslationsPublicationId = undefined;

const pool = new Pool()

const extractLanguageAndI18n = (data) => {
  const keys = []
  const map = {
    nn: {},
    en: {},
  }
  data.forEach(item => {
    const {language, i18n, form} = item.data;
    const allKeys = Object.keys(i18n)
    allKeys.forEach(key => {
      if (!keys.includes(key)) {
        keys.push(key)
      }
    })
    const lang = language === 'nn-NO' ? 'nn' : language
    if (map[lang] && Object.keys(map[lang]).length) {
      logger.info(`Duplicate language resource [${lang} - ${form}]`)
    }
    map[lang] = {...map[lang], ...i18n}
  });
  return {keys, ...map};
};

const skippedFormTranslationsCounters = {};
const insertTranslations = (client, formId, key, nn, en, skjemanummer) => async () => {
  if (key.length > maxLengthTranslation || nn?.length > maxLengthTranslation || en?.length > maxLengthTranslation) {
    let tooLongKey = key.substring(0, (key.length > 40 ? 40 : key.length));
    logger.info(`[${skjemanummer}] Skipping translation because key or value is too long [${tooLongKey} ...]`)
    summary.skjemanummer(skjemanummer).tooLongTranslations(`${tooLongKey} ...`, {nn: nn?.length, en: en?.length, key: key.length});
    skippedFormTranslationsCounters[skjemanummer] = (skippedFormTranslationsCounters[skjemanummer] || 0) + 1;
    return Promise.resolve()
  }
  const existsRes = await client.query(
    'SELECT id FROM form_translation WHERE key=$1 AND form_id=$2',
    [key, formId]
  )
  if (existsRes.rows.length) {
    skippedFormTranslationsCounters[skjemanummer] = (skippedFormTranslationsCounters[skjemanummer] || 0) + 1;
    const revisionRes = await client.query('SELECT id FROM form_translation_revision WHERE form_translation_id=$1 ORDER BY created_at DESC LIMIT 1', [existsRes.rows[0].id]);
    return Promise.resolve(revisionRes.rows[0].id)
  }
  let translationRevisionId = undefined
  if (!dryRun) {
    const res = await client.query(
      'INSERT INTO form_translation(form_id, key) VALUES($1,$2) RETURNING id',
      [
        formId,
        key,
      ]
    )
    const translationId = res.rows[0].id
    const translationRevisionRes = await client.query(
      'INSERT INTO form_translation_revision(form_translation_id, revision, nb, nn, en, created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [
        translationId,
        1,
        key,
        nn,
        en,
        'IMPORT'
      ]
    )
    translationRevisionId = translationRevisionRes.rows[0].id
  }
  return Promise.resolve(translationRevisionId)
}

const insertFormPromise = (form) => async () => {
  if (form.properties.skjemanummer.length > 24) {
    logger.info(`[${form.properties.skjemanummer}] Skipping form because skjemanummer is too long (_id=${form._id}, title=${form.title})`)
    summary.skjemanummer(form.properties.skjemanummer).tooLong()
    return Promise.resolve()
  }
  const client = await pool.connect()
  try {
    logger.info(`[${form.properties.skjemanummer}] Importing form...`)

    await client.query('BEGIN')
    const existsRes = await client.query('SELECT id FROM form WHERE path=$1', [form.path]);
    let formId = null
    let formRevisionId = null
    if (existsRes.rows.length) {
      formId = existsRes.rows[0].id
      logger.info(`[${form.properties.skjemanummer}] Skipping insert, form already exists (dbId=${formId})`)
      const formRevisionRes = await client.query('SELECT id FROM form_revision WHERE form_id=$1 ORDER BY created_at DESC LIMIT 1', [formId]);
      formRevisionId = formRevisionRes.rows[0].id;
    } else {
      if (!dryRun) {
        const res = await client.query(
          'INSERT INTO form(skjemanummer, path, created_at, created_by) VALUES($1,$2,$3,$4) RETURNING id',
          [
            form.properties.skjemanummer,
            form.path,
            form.created,
            'IMPORT',
          ]
        )
        const {id} = res.rows[0]
        formId = id
        const revisionRes = await client.query(
          'INSERT INTO form_revision(form_id, revision, title, components, properties, created_at, created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [
            id,
            1,
            form.title,
            JSON.stringify(form.components),
            JSON.stringify(form.properties),
            form.properties.modified || new Date().toISOString(),
            form.properties.modifiedBy || 'ukjent',
          ]
        )
        formRevisionId = revisionRes.rows[0].id
      }
    }
    const translations = await formioApi.fetchTranslations(form.path)
    const t = extractLanguageAndI18n(translations);
    if (translations.length > 2) {
      summary.skjemanummer(form.properties.skjemanummer).moreThanTwoTranslations(translations.length)
    }
    const translationPromises = t.keys.map(key => insertTranslations(client, formId, key, t.nn[key], t.en[key], form.properties.skjemanummer))
    const translationRevisionIds = (await Promise.all(translationPromises.map(insertT => insertT()))).filter(id => !!id);
    logger.info(`[${form.properties.skjemanummer}] Form translations imported (${translationRevisionIds.length})`)
    if (!dryRun && form.properties.published && !form.properties.unpublished) {
      logger.info(`[${form.properties.skjemanummer}] Publishing form and translations (${form.properties.published})...`)
      const publicationRes = await client.query(
        'INSERT INTO published_form_translation(form_id, created_at, created_by) VALUES($1,$2,$3) RETURNING id',
        [formId, form.properties.published, "IMPORT"]
      )
      const formTranslationPublicationId = publicationRes.rows[0].id
      if (translationRevisionIds.length) {
        const publishedRevisionValues = translationRevisionIds.map(revisionId => [formTranslationPublicationId, revisionId]);
        await client.query(
          pgFormat(
            'INSERT INTO published_form_translation_revision(published_form_translation_id, form_translation_revision_id) VALUES %L',
            publishedRevisionValues
          ),
          []
        )
      }
      const languages = (form.properties.publishedLanguages || []).map(lang => {
        if (lang === "nb-NO") {
          return "nb";
        } else if (lang === "nn-NO") {
          return "nn"
        }
        return lang;
      })
      if (!languages.includes("nb")) {
        languages.push("nb")
      }
      await client.query(
        'INSERT INTO form_publication(form_revision_id, published_form_translation_id, published_global_translation_id, languages, created_at, created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [formRevisionId, formTranslationPublicationId, globalTranslationsPublicationId, JSON.stringify(languages), form.properties.published, "IMPORT"]
      )

    }
    logger.info(`[${form.properties.skjemanummer}] Form and translations published ok`)

    await client.query('COMMIT')
    summary.skjemanummer(form.properties.skjemanummer).successInsert();
    logger.info(`[${form.properties.skjemanummer}] Form imported successfully (dbId=${formId}, translations={inserted: ${t.keys.length}, skipped: ${skippedFormTranslationsCounters[form.properties.skjemanummer] || 0}})`)
  } catch (e) {
    summary.skjemanummer(form.properties.skjemanummer).failedInsert();
    logger.error(`[${form.properties.skjemanummer}] Failed to insert (_id=${form._id})`, e)
    await client.query('ROLLBACK')
  } finally {
    await client.release()
  }
  return Promise.resolve()
}

const importGlobalTranslations = async () => {
  const globalTranslationsMap = await formioApi.fetchGlobalTranslations();
  let counterNew = 0;
  let counterExisting = 0;
  const translationRevisionIds = [];
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    let globalTranslations = Object.entries(globalTranslationsMap);
    logger.info(`Importing ${globalTranslations.length} global translation keys...`)
    const promises = globalTranslations.map(([key, tObject]) => async () => {
      const {nn, en, tag} = tObject;
      const nb = tag !== 'validering' ? key : null;

      const existsRes = await client.query(
        'SELECT id FROM global_translation WHERE key=$1',
        [key]
      )
      if (existsRes.rows.length) {
        counterExisting = counterExisting + 1;
        // global translation already exists, find revision id for possible publication
        const revisionRes = await client.query(
          'SELECT id FROM global_translation_revision WHERE global_translation_id=$1',
          [existsRes.rows[0].id],
        )
        translationRevisionIds.push(revisionRes.rows[0].id)
        return Promise.resolve()
      }
      if (!dryRun) {
        const res = await client.query(
          'INSERT INTO global_translation(key, tag) VALUES($1,$2) RETURNING id',
          [
            key,
            tag,
          ]
        )
        const translationId = res.rows[0].id
        const revisionRes = await client.query(
          'INSERT INTO global_translation_revision(global_translation_id, revision, nb, nn, en, created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [
            translationId,
            1,
            nb,
            nn,
            en,
            'IMPORT',
          ]
        )
        const revisionId = revisionRes.rows[0].id
        translationRevisionIds.push(revisionId)
      }
      counterNew = counterNew + 1;
    });
    await Promise.all(promises.map(f => f()))

    if (translationRevisionIds.length && counterNew > 0) {
      logger.info(`Publishing global translations...`)
      if (!dryRun) {
        const publicationRes = await client.query(
          'INSERT INTO published_global_translation(created_by) VALUES($1) RETURNING id',
          ["IMPORT"]
        );
        globalTranslationsPublicationId = publicationRes.rows[0].id;
        const publishedRevisionValues = translationRevisionIds.map(revisionId => [globalTranslationsPublicationId, revisionId]);

        await client.query(
          pgFormat(
            'INSERT INTO published_global_translation_revision(published_global_translation_id, global_translation_revision_id) VALUES %L',
            publishedRevisionValues
          ),
          []
        );
      }
      logger.info(`Global translations published ok`)
    } else {
      logger.info(`No new global translations to publish`)
      if (!dryRun) {
        const publicationRes = await client.query('SELECT id FROM published_global_translation ORDER BY created_at DESC LIMIT 1');
        globalTranslationsPublicationId = publicationRes.rows[0].id;
      }
    }
    await client.query('COMMIT')
    logger.info(`Global translations inserted (${counterNew} new, ${counterExisting} existing)`)
  } catch (e) {
    await client.query('ROLLBACK')
    logger.error(`Failed to insert and publish global translations`, e)
    throw e;
  } finally {
    await client.release()
  }
}

const main = async () => {
  try {
    if (dryRun) {
      console.log("::::::::: DRY RUN ::::::::::")
    }
    await importGlobalTranslations();
    const forms = (await formioApi.fetchForms()).filter(form => !!form.properties && form.properties.isTestForm !== true)
    logger.info(`Importing ${forms.length} forms...`)
    const promises = forms.map(form => insertFormPromise(form))
    await Promise.all(promises.map(f => f()))
  } catch (err) {
    logger.error(`Error importing data:`, err)
  } finally {
    logger.info(`Summary: ${JSON.stringify(summary.get())}`)
    await pool.end()
  }
}

main()
