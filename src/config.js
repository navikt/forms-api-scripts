import dotenv from "dotenv";

dotenv.config()

const config = {
  formioBaseUrl: process.env.FORMIO_BASE_URL || "",
  maxNumberOfForms: process.env.MAX_NUMBER_OF_FORMS || 1000,
  dryRun: process.env.DRY_RUN === 'true',
  maxLengthTranslation: 5120,
}

export default config;
