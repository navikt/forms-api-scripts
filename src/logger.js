import config from './config.js'

const { dryRun } = config

const logInfo = (msg) => console.log(`${dryRun ? '[DRYRUN] ' : ''}${msg}`)
const logError = (msg, err) => console.error(`${dryRun ? '[DRYRUN] ' : ''}${msg}`, err)

const logger = {
  error: (msg, err) => logError(msg, err),
  info: (msg) => logInfo(msg),
}

export default logger
