import config from './config.js'
import logger from './logger.js'

const { formioBaseUrl, maxNumberOfForms } = config

const fetchTranslations = async (formPath) => {
  try {
    const response = await fetch(`${formioBaseUrl}/language/submission?data.name=global.${formPath}&limit=1000`)
    if (!response.ok) {
      throw new Error(`[${formPath}] Failed to fetch translations: ${response.statusText}`)
    }
    return await response.json()
  } catch (err) {
    logger.error(`[${formPath}] Error fetching translations:`, err)
    throw err
  }
}

const transformGlobalTranslations = (globalTranslations) => {
  return globalTranslations.reduce((acc, globalTranslation) => {
    const {language, tag, i18n} = globalTranslation.data;
    const lang = language === 'nn-NO' ? 'nn' : language
    const texts = {}
    Object.entries(i18n).forEach(([key, value]) => {
      const keyObject = acc[key] || {tag}
      texts[key] = {...keyObject, [lang]: value}
    });
    return {...acc, ...texts}
  }, {})
}

const fetchGlobalTranslations = async () => {
  try {
    const response = await fetch(`${formioBaseUrl}/language/submission?data.name=global&limit=1000`)
    if (!response.ok) {
      throw new Error(`Failed to fetch global translations: ${response.statusText}`)
    }
    let globalLanguageSubmissions = await response.json();
    logger.info(`Fetched ${globalLanguageSubmissions.length} global language resources from formio-api...`)
    return transformGlobalTranslations(globalLanguageSubmissions);
  } catch (err) {
    logger.error(`Error fetching global translations:`, err)
    throw err
  }
}

const fetchForms = async () => {
  try {
    logger.info(`Fetching forms...`)
    const response = await fetch(`${formioBaseUrl}/form?type=form&tag=nav-skjema&limit=${maxNumberOfForms}`)
    if (!response.ok) {
      throw new Error(`Failed to fetch forms: ${response.statusText}`)
    }
    return await response.json()
  } catch (err) {
    logger.error(`Error fetching forms:`, err)
    throw err
  }
}

const formioApi = {
  fetchTranslations,
  fetchGlobalTranslations,
  fetchForms,
}

export default formioApi;
