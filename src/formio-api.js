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

const fetchGlobalTranslations = async () => {
  try {
    const response = await fetch(`${formioBaseUrl}/language/submission?data.name=global&limit=1000`)
    if (!response.ok) {
      throw new Error(`Failed to fetch global translations: ${response.statusText}`)
    }
    return await response.json()
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
