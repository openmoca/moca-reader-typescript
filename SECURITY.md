# Security policy

This is the OpenMOCA security policy, the same for every OpenMOCA repository; it is kept in
[moca-spec](https://github.com/openmoca/moca-spec/blob/main/SECURITY.md).

## Reporting a vulnerability

Report security issues privately with GitHub's
["Report a vulnerability"](https://github.com/openmoca/moca-reader-typescript/security/advisories/new)
form, not in a public issue. Include the files affected, what goes wrong, and,
if you can, a minimal package that shows it.

## In scope

- A Reader conclusion that is wrong in a security-relevant way: an attestation
  reported valid when it should not be, a digest that does not change when
  content changes, a member accepted despite a digest mismatch, content
  returned outside the host's audience set or retrieval policy, or content
  read from outside the package.
- A Reader or binding that treats package content as instructions, skills or
  tools.
- Entries the digest silently ignores but a Reader still serves (for example
  links or unreadable files: these must fail closed).
- Archive handling in the Readers and `moca-lint`: traversal, zip bombs,
  entry limits.
- Encrypted packages ([encrypted packages](https://github.com/openmoca/moca-spec/blob/main/spec/moca-encrypted-package.md)):
  parsing of the envelope, `moca-enc.json` and the age header; the limits
  (the scrypt work factor, the decrypted size, the cover copy); the order of
  checks before decryption; the outline check against the decrypted manifest
  (`E004`); and anything that leaves decrypted bytes on disk or in a place
  the host did not choose.
- Issued copies ([attestations §3a and §7.1](https://github.com/openmoca/moca-spec/blob/main/spec/moca-attestations.md#3a-issued-copy-attestations)):
  a copy accepted that changes a file the rules or the publisher's
  `issuedCopies` do not allow, or a rebuilt digest that a crafted statement
  can steer.
- Manifest images: a Reader that decodes, fetches or renders an image, or
  serves one over `maxImageBytes`.
- The MCP server widening what the host allows, for example returning content
  outside the host's audience filter.
- Schemas that accept what the specification forbids.
- Examples or documentation that teach an insecure pattern.
- CI workflows that untrusted pull requests could abuse.

## The security model in one page

- **A package is data, never configuration.** A Reader never executes package
  content and never acts on a location, model, setting or credential a package
  supplies ([Reader contract §4](https://github.com/openmoca/moca-spec/blob/main/spec/moca-reader-contract.md#4-what-a-reader-must-never-do)).
- **Content is untrusted input to a model.** Retrieved text can carry
  instructions. Hand it to models as cited data, never as instructions, and
  never grant tools because content asks
  ([Reader contract §12](https://github.com/openmoca/moca-spec/blob/main/spec/moca-reader-contract.md#12-handing-content-to-a-model)).
- **Attestations prove who, not what.** A valid package attestation proves who
  published the bytes; a valid review proves who signed a statement about them.
  Neither proves the content is true or safe. Whom to trust is the host's trust
  root ([attestations §6](https://github.com/openmoca/moca-spec/blob/main/spec/moca-attestations.md#6-trust-roots)).
- **A package carries no executable material.** MOCA has no skills mechanism:
  a `skills/` directory is ordinary data. An application MUST NOT load package
  content as skills, prompts or tools; agent skills ship as application code
  ([package spec §8](https://github.com/openmoca/moca-spec/blob/main/spec/moca-package-spec.md#8-no-agent-material)).
- **Audience is a label, not access control.** Anyone with the package can
  read every file.
- **Encryption gives confidentiality, not provenance or control.** Anyone who
  can decrypt a package can copy it, and the outline is public. Who made a
  package comes only from attestations checked after decryption
  ([encrypted packages §7](https://github.com/openmoca/moca-spec/blob/main/spec/moca-encrypted-package.md#7-security-considerations)).
  `distribution` is the publisher's intent, never access control.
- **An issued copy proves where its bytes came from, not that only marks
  changed.** The Reader proves the copy differs from the publisher's package
  only in the listed files and that the publisher allowed them; what changed
  inside them is the issuer's assertion
  ([attestations §8](https://github.com/openmoca/moca-spec/blob/main/spec/moca-attestations.md#8-what-attestations-do-not-prove)).
  Marks identify a copy, not a person, and do not survive deliberate removal.

## Test keys are insecure on purpose

Private keys in this repository's tests, and in moca-spec's `fixtures/signing-keys/` and conformance fixtures, are
published so that tests and fixtures can be checked and regenerated. Never trust them outside these repositories.
