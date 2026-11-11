// Audience (package spec §5.3, Reader contract §8, moca-spec ADR-0016).
//
// - A node's label is its `moca.audience`, a non-empty string.
// - A translation with no `moca.audience` of its own takes the label of the
//   node's default representation.
// - A label that is present but not a non-empty string is malformed: it never
//   matches any audience set, even when the host allows unlabelled content.
// - When the host supplies an audience set, a record with no label is outside
//   it unless the host sets `allowUnlabelled`.

/**
 * @param {{ representations: Array<{ frontmatter: object }> }} node
 * @param {{ frontmatter: object }} rep
 * @returns {{ label?: string, invalid: boolean }}
 */
export function audienceOf(node, rep) {
  const own = rep.frontmatter?.moca;
  const source = own && typeof own === 'object' && Object.hasOwn(own, 'audience')
    ? own
    : node?.representations?.[0]?.frontmatter?.moca;
  if (!source || typeof source !== 'object' || !Object.hasOwn(source, 'audience')) return { invalid: false };
  const value = source.audience;
  return typeof value === 'string' && value !== '' ? { label: value, invalid: false } : { invalid: true };
}

/**
 * Whether a label passes the host's audience set.
 * @param {{ label?: string, invalid?: boolean }} audience
 * @param {string[]|undefined} audiences
 * @param {boolean} [allowUnlabelled]
 */
export function audienceAllowed({ label, invalid }, audiences, allowUnlabelled = false) {
  if (!audiences) return true;
  if (invalid) return false;
  if (label === undefined) return allowUnlabelled;
  return audiences.includes(label);
}

/** The audience of a citation record, for the gate and store backends. */
export const recordAudience = (record) => ({ label: record.audience, invalid: record.audienceInvalid === true });
