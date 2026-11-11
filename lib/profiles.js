// Profiles this reference reader recognises. Recognising a profile only stops
// F001 from being reported; profile data stays opaque to core. The ontology
// profile carries extra vocabulary files that the Reader passes through.
export const PROFILE_ONTOLOGY = 'https://w3id.org/moca/profiles/ontology/v1';

export const KNOWN_PROFILES = Object.freeze([PROFILE_ONTOLOGY]);
