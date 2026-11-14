// @openmoca/moca-core: the reference MOCA Reader, plus the primitives the
// Producer tools share. See spec/moca-reader-contract.md.
export { readPackage, MOCA_VERSION } from './reader.js';
export { isPrimeOrderPoint, strictEncodings } from './ed25519.js';
export { Library, citationFor, passesDefaultPolicy } from './library.js';
export { audienceOf, audienceAllowed, recordAudience } from './audience.js';
export { Search } from './search.js';
export { StructureIndex } from './structure-ops.js';
export { ontologyGuided } from './strategies/ontology-guided.js';
export { diversify } from './strategies/diversify.js';
export { LexicalBackend } from './backends/lexical.js';
export { DenseBackend, modelMismatch, similarity } from './backends/dense.js';
export { MemoryStoreBackend } from './backends/memory-store.js';
export { HybridBackend } from './backends/hybrid.js';
export { selectorMatches } from './content.js';
export { readStructure, parseStructure, StructureGraph, structureView, STRUCTURE_FILE, LAYERS } from './structure.js';
export { bindSidecar, PORTABLE_FORMAT, SIDECAR_MANIFEST } from './sidecar.js';
export { bindEnvelopeSidecar, isEnvelope } from './envelope.js';
export { directoryResolver } from './resolver.js';
export { openSource, directorySource, archiveSource, hostSource, TargetError, DEFAULT_LIMITS } from './source.js';
export { computeDigest, manifestText, manifestPath, packageFiles, sha256Hex, DIGEST_ALGORITHM, DIGEST_PATTERN, MANIFEST, ATTESTATIONS_DIR } from './digest.js';
export {
  loadTrustRoot, packageStatement, reviewStatement, parseAttestation, verifySignature,
  STATEMENT_TYPE, PAYLOAD_TYPE, PREDICATE_PACKAGE, PREDICATE_REVIEW,
} from './attestations.js';
export { createEnvelope, verifyEnvelope, preAuthEncode } from './dsse.js';
export { splitFrontmatter, joinFrontmatter, prependFrontmatterKeys } from './frontmatter.js';
export { SCHEMAS, validateAgainst } from './schemas.js';
export { CODES, RETIRED_CODES, SEVERITY, defaultSeverity } from './codes.js';
export { Diagnostics, countBySeverity } from './diagnostics.js';
export { formatText, formatJson, formatSarif } from './format.js';
export { KNOWN_PROFILES, PROFILE_ONTOLOGY } from './profiles.js';
export { packageState } from './state.js';
