import pg from 'pg'
import config from './src/config.js'
import logger from './src/logger.js'
import formioApi from './src/formio-api.js'

const {Pool} = pg;

const {
  dryRun,
  formioBaseUrl,
  maxLengthTranslation,
} = config;

if (!formioBaseUrl) {
  throw new Error(`FORMIO_BASE_URL environment variable is not set`);
}

const pool = new Pool()

const scriptSummary = {
  maxTranslationLength: 0,
  formsWithTooLongTranslation: [],
  tooLongSkjemannummer: [],
  moreThanTwoTranslations: [],
  failedInsertsSkjemanummer: [],
  successInsertsSkjemanummer: [],
}

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
    scriptSummary.maxTranslationLength = key.length || 0
    if (nn?.length && (nn.length > scriptSummary.maxTranslationLength)) {
      scriptSummary.maxTranslationLength = nn.length
    }
    if (en?.length && (en.length > scriptSummary.maxTranslationLength)) {
      scriptSummary.maxTranslationLength = en.length
    }
    let tooLongKey = key.substring(0, (key.length > 40 ? 40 : key.length));
    logger.info(`[${skjemanummer}] Skipping translation because key or value is too long [${tooLongKey}...]`)
    scriptSummary.formsWithTooLongTranslation.push({
      skjemanummer,
      tooLongKey,
      keyLength: key.length,
      nnLength: nn?.length,
      enLength: en?.length
    })
    skippedFormTranslationsCounters[skjemanummer] = (skippedFormTranslationsCounters[skjemanummer] || 0) + 1;
    return Promise.resolve(false)
  }
  const existsRes = await client.query(
    'SELECT id FROM form_translation WHERE key=$1 AND form_id=$2',
    [key, formId]
  )
  if (existsRes.rows.length) {
    skippedFormTranslationsCounters[skjemanummer] = (skippedFormTranslationsCounters[skjemanummer] || 0) + 1;
    return Promise.resolve(false)
  }
  if (!dryRun) {
    const res = await client.query(
      'INSERT INTO form_translation(form_id, key) VALUES($1,$2) RETURNING id',
      [
        formId,
        key,
      ]
    )
    const translationId = res.rows[0].id
    await client.query(
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
  }
  return Promise.resolve(true)
}

const insertFormPromise = (form) => async () => {
  if (form.properties.skjemanummer.length > 24) {
    logger.info(`[${form.properties.skjemanummer}] Skipping form because skjemanummer is too long (_id=${form._id}, title=${form.title})`)
    scriptSummary.tooLongSkjemannummer.push(form.properties.skjemanummer)
    return Promise.resolve()
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existsRes = await client.query('SELECT id FROM form WHERE path=$1', [form.path]);
    let formId = null
    if (existsRes.rows.length) {
      formId = existsRes.rows[0].id
      logger.info(`[${form.properties.skjemanummer}] Skipping insert, form already exists (dbId=${formId})`)
    } else {
      if (!dryRun) {
        const res = await client.query(
          'INSERT INTO form(skjemanummer, path, created_by) VALUES($1,$2,$3) RETURNING id',
          [
            form.properties.skjemanummer,
            form.path,
            'IMPORT',
          ]
        )
        const {id} = res.rows[0]
        formId = id
        await client.query(
          'INSERT INTO form_revision(form_id, revision, title, components, properties, created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [
            id,
            1,
            form.title,
            JSON.stringify(form.components),
            JSON.stringify(form.properties),
            form.properties.modifiedBy || 'ukjent',
          ]
        )
      }
    }
    const translations = await formioApi.fetchTranslations(form.path)
    const t = extractLanguageAndI18n(translations);
    if (translations.length > 2) {
      scriptSummary.moreThanTwoTranslations.push({
        skjemanummer: form.properties.skjemanummer,
        numberOfTranslations: translations.length
      })
    }
    const translationPromises = t.keys.map(key => insertTranslations(client, formId, key, t.nn[key], t.en[key], form.properties.skjemanummer))
    await Promise.all(translationPromises.map(insertT => insertT()))
    await client.query('COMMIT')
    scriptSummary.successInsertsSkjemanummer.push(form.properties.skjemanummer);
    logger.info(`[${form.properties.skjemanummer}] Form inserted (dbId=${formId}, translations={inserted: ${t.keys.length}, skipped: ${skippedFormTranslationsCounters[form.properties.skjemanummer] || 0}})`)
  } catch (e) {
    scriptSummary.failedInsertsSkjemanummer.push(form.properties.skjemanummer);
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
        // global translation already exists
        counterExisting = counterExisting + 1;
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
        await client.query(
          'INSERT INTO global_translation_revision(global_translation_id, revision, nb, nn, en, created_by) VALUES($1,$2,$3,$4,$5,$6)',
          [
            translationId,
            1,
            nb,
            nn,
            en,
            'IMPORT',
          ]
        )
      }
      counterNew = counterNew + 1;
    });
    await Promise.all(promises.map(f => f()))
    await client.query('COMMIT')
    logger.info(`Global translations inserted (${counterNew} new, ${counterExisting} existing)`)
  } catch (e) {
    await client.query('ROLLBACK')
    logger.error(`Failed to insert global translations`, e)
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
    logger.info(`Summary: ${JSON.stringify(scriptSummary)}`)
    await pool.end()
  }
}

main()
