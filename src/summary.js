const data = {
  formsWithTooLongTranslation: [],
  tooLongSkjemannummer: [],
  moreThanTwoTranslations: [],
  failedInsertsSkjemanummer: [],
  successInsertsSkjemanummer: [],
}

const summary = {
  skjemanummer: (skjemanummer) => ({
    tooLong: () => data.tooLongSkjemannummer.push(skjemanummer),
    failedInsert: () => data.failedInsertsSkjemanummer.push(skjemanummer),
    successInsert: () => data.successInsertsSkjemanummer.push(skjemanummer),
    moreThanTwoTranslations: (numberOfTranslations) => data.moreThanTwoTranslations.push(
      {skjemanummer, numberOfTranslations}),
    tooLongTranslations: (tooLongKey, lengths) => data.formsWithTooLongTranslation.push(
      {skjemanummer, tooLongKey, lengths}
    ),
  }),
  get: () => data,
}

export default summary;
