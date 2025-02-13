export const getPublicationInfo = (form) => {
  let publicationStatus = undefined;
  let publicationCreatedAt = undefined;
  let publicationCreatedBy = undefined;
  if (!form.properties.isTestForm) {
    if (form.properties.unpublished) {
      publicationStatus = 'unpublished'
      publicationCreatedAt = form.properties.unpublished
      publicationCreatedBy = form.properties.unpublishedBy
    } else if (form.properties.published) {
      publicationStatus = 'published'
      publicationCreatedAt = form.properties.published
      publicationCreatedBy = form.properties.publishedBy
    }
  }
  return {publicationStatus, publicationCreatedAt, publicationCreatedBy}
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

export const getFormLock = (form) => {
  const {
    isLockedForm,
    lockedFormReason,
    modified
  } = form.properties;
  return isLockedForm
    ? JSON.stringify({reason: lockedFormReason || "Ukjent", createdBy: "IMPORT", createdAt: modified})
    : null;
}
