import dotenv from 'dotenv'
import pg from 'pg'

const { Pool } = pg;

dotenv.config()

const dryRun = process.env.DRY_RUN === 'true';
const maxNumberOfForms = process.env.MAX_NUMBER_OF_FORMS || 1000;
const maxLengthTranslation = 5120;

const formioBaseUrl = process.env.FORMIO_BASE_URL;


if (!formioBaseUrl) {
  throw new Error('FORMIO_BASE_URL environment variable is not set');
}

const pool = new Pool()

const scriptSummary = {
  maxTranslationLength: 0,
  formsWithTooLongTranslation: [],
  tooLongSkjemannummer: [],
  moreThanTwoTranslations: [],
}

const fetchTranslations = async (formPath) => {
  try {
    const response = await fetch(`${formioBaseUrl}/language/submission?data.name=global.${formPath}&limit=1000`)
    if (!response.ok) {
      throw new Error(`Failed to fetch translations: ${response.statusText}`)
    }
    return await response.json()
  } catch (err) {
    console.error('Error fetching translations:', err)
    throw err
  }
}

const extractLanguageAndI18n = (data) => {
  const keys = []
  const map = {
    nn: {},
    en: {},
  }
  data.forEach(item => {
    const { language, i18n, form } = item.data;
    const allKeys = Object.keys(i18n)
    allKeys.forEach(key => {
      if (!keys.includes(key)) {
        keys.push(key)
      }
    })
    const lang = language === 'nn-NO' ? 'nn' : language
    if (map[lang] && Object.keys(map[lang]).length) {
      console.log(`Duplicate language resource [${lang} - ${form}]`)
    }
    map[lang] = { ...map[lang], ...i18n }
  });
  return { keys, ...map };
};

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
    console.log(`[${skjemanummer}] Skipping translation because key or value is too long [${tooLongKey}...]`)
    scriptSummary.formsWithTooLongTranslation.push({skjemanummer, tooLongKey, keyLength: key.length, nnLength: nn?.length, enLength: en?.length})
    return Promise.resolve()
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
  return Promise.resolve()
}

const insertFormPromise = (form) => async () => {
  if (!form.properties) {
    console.log(`Skipping form without properties (_id=${form._id} path=${form.path})`)
    return Promise.resolve()
  } else if (form.properties.skjemanummer.length > 24) {
    console.log(`[${form.properties.skjemanummer}] Skipping form because skjemanummer is too long (_id=${form._id}, title=${form.title})`)
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
      console.log(`[${form.properties.skjemanummer}] Skipping insert, form already exists (dbId=${formId})`)
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
      console.log(`[${form.properties.skjemanummer}] Form inserted (dbId=${formId})`)
    }
    console.debug(`[${form.properties.skjemanummer}] Loading translations... (dbId=${formId})`)
    const translations = await fetchTranslations(form.path)
    console.log(`[${form.properties.skjemanummer}] Loaded ${translations.length} translations`)
    const t = extractLanguageAndI18n(translations);
    if (translations.length > 2) {
      scriptSummary.moreThanTwoTranslations.push({skjemanummer: form.properties.skjemanummer, numberOfTranslations: translations.length})
    }
    const translationPromises = t.keys.map(key => insertTranslations(client, formId, key, t.nn[key], t.en[key], form.properties.skjemanummer))
    await Promise.all(translationPromises.map(insertT => insertT()))

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(`[${form.properties.skjemanummer}] Failed to insert (_id=${form._id})`, e)
  } finally {
    client.release()
  }
  return Promise.resolve()
}

const fetchForms = async () => {
  try {
    const response = await fetch(`${formioBaseUrl}/form?type=form&tag=nav-skjema&limit=${maxNumberOfForms}`)
    if (!response.ok) {
      throw new Error(`Failed to fetch forms: ${response.statusText}`)
    }
    return await response.json()
  } catch (err) {
    console.error('Error fetching forms:', err)
    throw err
  }
}

const main = async () => {
  try {
    if (dryRun) {
      console.log("::::::::: DRY RUN ::::::::::")
    }
    const forms = (await fetchForms()).filter(form => !!form.properties && form.properties.isTestForm !== true)
    console.log(`Importing ${forms.length} forms...`)
    const promises = forms.map(form => insertFormPromise(form))
    await Promise.all(promises.map(f => f()))
  } catch (err) {
    console.error('Error processing forms:', err)
  } finally {
    console.log(`Summary: ${JSON.stringify(scriptSummary)}`)
    await pool.end()
  }
}

main()
