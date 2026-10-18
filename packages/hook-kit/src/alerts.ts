/**
 * The spoken permission alert shared by hook adapters (US-012): `<label> needs your approval to use
 * <tool>.`, or `<label> needs your approval.` when the tool is unknown.
 */
export function approvalText(label: string, tool?: string | null): string {
  return tool ? `${label} needs your approval to use ${tool}.` : `${label} needs your approval.`;
}
