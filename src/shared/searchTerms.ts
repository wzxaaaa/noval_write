export function tokenizeSearchText(text: string): string[] {
  const normalized = text.toLowerCase()
  const terms: string[] = []

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+|[a-z0-9]+/g)) {
    const part = match[0]
    if (!/[\u3400-\u9fff]/.test(part)) {
      terms.push(part)
      continue
    }

    if (part.length === 1) {
      terms.push(part)
      continue
    }

    // Chinese normally has no whitespace. Character bigrams give natural
    // questions and prose a shared vocabulary without requiring a dictionary.
    for (let index = 0; index < part.length - 1; index++) {
      terms.push(part.slice(index, index + 2))
    }
  }

  return terms
}
