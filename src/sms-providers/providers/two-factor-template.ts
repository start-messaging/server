/**
 * Working out the variables of a 2Factor R1 template send.
 *
 * R1 takes a template NAME and the values for its numbered slots
 * (`var1`..`varN`), not the message text. The operator then compares the text
 * 2Factor assembles with the DLT-approved template, so the slots have to be
 * filled with exactly the text that belongs in them.
 *
 * Our own templates do not always divide the message the way DLT does. The
 * approved expiry template reads "valid for #VAR2#." while ours reads
 * "valid for {{expiry}} minutes." — so DLT's second slot is "5 minutes", not
 * "5". Mapping our placeholders onto DLT's slots one for one would send "5" and
 * silently change the wording of every SMS from that template. So the slots
 * are not taken from our placeholders at all: the approved template text is
 * kept beside the template, and the values are read back out of the message we
 * rendered by matching it against that text. What leaves here is, by
 * construction, the same message that would have been sent as plain text — and a
 * template whose body has drifted away from its DLT text is caught at send
 * time, here, instead of as a rejection nobody can explain.
 */

/**
 * DLT slot markers. The DLT portal writes `{#var#}`; 2Factor's own template
 * list shows the same slots as `#VAR1#`, `#VAR2#`. Either may be stored.
 */
const SLOT = /\{#var#\}|#VAR\d*#/gi;

/** Whitespace is not significant to the operator's match, so it is not to ours. */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How many `#VARn#` slots the approved text has. */
export function countTemplateSlots(dltText: string): number {
  return (dltText.match(SLOT) ?? []).length;
}

/**
 * Reads the slot values out of a rendered message, or returns `null` when the
 * message is not an instance of the approved template.
 *
 * A template with no slots matches only an identical message, and yields no
 * values. The literal text between slots must match exactly (after whitespace
 * is squashed); the slots take whatever sits between them, shortest first.
 */
export function extractTemplateVariables(
  dltText: string,
  rendered: string,
): string[] | null {
  const literals = squash(dltText).split(SLOT).map(escapeRegExp);
  const pattern = new RegExp(`^${literals.join('(.+?)')}$`, 's');
  const match = squash(rendered).match(pattern);
  // Trimmed: padding next to a slot belongs to the sentence, not to the value.
  return match ? match.slice(1).map((v) => v.trim()) : null;
}
