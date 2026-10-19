import type { PaymentCategory, PaymentDraft } from './types'

export function paymentFingerprint(draft: Pick<PaymentDraft, 'category' | 'recipient' | 'amount' | 'reference_month'>) {
  return [draft.category, draft.recipient.trim().toLowerCase(), Number(draft.amount).toFixed(2), draft.reference_month].join('|')
}

function amountFrom(value: string) {
  const cleaned = value.replace(/[^\d,.-]/g, '')
  if (!cleaned) return 0
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned
  const amount = Number(normalized)
  return Number.isFinite(amount) ? amount : 0
}

function toIsoDate(day: string, month: string, year: string) {
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  const date = new Date(`${iso}T12:00:00`)
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== iso ? '' : iso
}

function extractPaymentDate(text: string) {
  const lines = text.split(/\r?\n/)
  const datePattern = /(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/
  const prioritized = lines.filter(line => /data\s*(?:do\s*)?(?:pagamento|transa[cç][aã]o|opera[cç][aã]o)|pago\s+em/i.test(line))
  for (const line of [...prioritized, ...lines]) {
    const match = line.match(datePattern)
    if (match) {
      const result = toIsoDate(match[1], match[2], match[3])
      if (result) return result
    }
  }
  return ''
}

function extractDasMonth(text: string, paymentDate: string) {
  const match = text.match(/(?:per[ií]odo\s+de\s+apura[cç][aã]o|m[eê]s\s+de\s+refer[eê]ncia|compet[eê]ncia|refer[eê]ncia)\s*[:\-]?\s*(0?[1-9]|1[0-2])[/.\-](\d{4})/i)
  if (match) return `${match[2]}-${match[1].padStart(2, '0')}-01`
  return paymentDate ? `${paymentDate.slice(0, 7)}-01` : ''
}

function extractRecipient(text: string) {
  const labels = /^(?:(?:nome\s+do\s+)?(?:recebedor|favorecido|benefici[aá]rio|destinat[aá]rio|convenente))\s*[:\-]?\s*(.+)$/i
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(labels)
    const value = match?.[1]?.trim().replace(/\s{2,}.*/, '')
    if (value && !/\d{8,}/.test(value)) return value.slice(0, 180)
  }
  return ''
}

function extractAmount(text: string) {
  const candidates = text.split(/\r?\n/).flatMap(line => {
    const values = Array.from(line.matchAll(/(?:R\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})/g))
    return values.map(match => {
      const label = line.toLowerCase()
      const priority = /valor\s*(?:pago|total|do pagamento|da transa[cç][aã]o|efetivado)|total\s+pago|pagamento\s+efetuado|valor:/i.test(label) ? 5
        : /saldo|juros|desconto|multa|limite|dispon[ií]vel/i.test(label) ? -4 : 0
      return { amount: amountFrom(match[1]), priority }
    })
  }).filter(item => item.amount > 0)
  candidates.sort((a, b) => b.priority - a.priority || b.amount - a.amount)
  return candidates[0]?.amount ?? 0
}

export function parsePaymentReceipt(text: string, category: PaymentCategory, source: PaymentDraft['source']): Partial<PaymentDraft> {
  const paymentDate = extractPaymentDate(text)
  const referenceMonth = category === 'das' ? extractDasMonth(text, paymentDate) : paymentDate ? `${paymentDate.slice(0, 7)}-01` : ''
  return {
    category,
    recipient: extractRecipient(text),
    amount: extractAmount(text),
    payment_date: paymentDate,
    reference_month: referenceMonth,
    source,
    fingerprint: '',
  }
}

export function makePaymentDraft(fields: Omit<PaymentDraft, 'fingerprint'>): PaymentDraft {
  return { ...fields, fingerprint: paymentFingerprint(fields) }
}

export function monthLabel(month: string) {
  if (!month) return ''
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month.slice(0, 7)}-01T12:00:00Z`))
}
