/**
 * Render a step's instruction template (`${{ inputs.<name> }}`,
 * `${{ run.id }}`, `${{ step.id }}`) — the only expressions the compiler
 * accepts (`validateTemplates`). Rendering happens once, when the Run is
 * created, so the Run records exactly the text its agents were given.
 *
 * An input that was not supplied (optional, and absent) renders as an empty
 * string; anything the compiler would have rejected is left as written.
 */
export function renderTemplate(
  template: string,
  values: { inputs: Readonly<Record<string, unknown>>; runId: string; stepId: string },
): string {
  return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (whole, raw: string) => {
    const expression = raw.trim()
    if (expression === 'run.id') return values.runId
    if (expression === 'step.id') return values.stepId
    const input = /^inputs\.([A-Za-z0-9_-]+)$/.exec(expression)
    if (input !== null) {
      const value = values.inputs[input[1] ?? '']
      return value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)
    }
    return whole
  })
}
