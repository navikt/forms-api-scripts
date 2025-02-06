export const getPublicationInfo = (form) => {
  let publicationStatus = undefined;
  let publicationCreatedAt = undefined;
  if (!form.properties.isTestForm) {
    if (form.properties.unpublished) {
      publicationStatus = 'unpublished'
      publicationCreatedAt = form.properties.unpublished
    } else if (form.properties.published) {
      publicationStatus = 'published'
      publicationCreatedAt = form.properties.published
    }
  }
  return {publicationStatus, publicationCreatedAt}
}

export const getPublishedLanguages = (form) => {
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
  return languages;
}