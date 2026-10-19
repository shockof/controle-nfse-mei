import type { InvoiceDraft, InvoiceStatus } from './types'

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? ''
const first = (doc: Document, selectors: string[]) => {
  for (const selector of selectors) {
    const found = doc.querySelector(selector)
    if (found && text(found)) return text(found)
  }
  return ''
}

export function fingerprint(draft: Pick<InvoiceDraft, 'company_name' | 'amount' | 'issue_date' | 'invoice_number'>) {
  return [draft.invoice_number?.trim().toLowerCase() || '', draft.company_name.trim().toLowerCase(), draft.issue_date,
    Number(draft.amount).toFixed(2)].join('|')
}

export function normalizeAmount(value: string): number {
  let cleaned = value.replace(/[^\d,.-]/g, '')
  if (cleaned.includes(',')) cleaned = cleaned.replace(/\./g, '').replace(',', '.')
  const result = Number(cleaned)
  return Number.isFinite(result) ? result : 0
}

export function parseNfseXml(xml: string): InvoiceDraft {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('O XML está inválido ou incompleto.')
  // Support common national NFS-e fields and municipal variants by local tag names.
  const byLocal = (names: string[]) => {
    const nodes = Array.from(doc.getElementsByTagName('*'))
    for (const n of nodes) if (names.includes(n.localName.toLowerCase()) && text(n)) return text(n)
    return ''
  }
  const tomadorName = Array.from(doc.getElementsByTagName('*')).find(node => {
    if (!['xnome', 'nome', 'razaosocial'].includes(node.localName.toLowerCase()) || !text(node)) return false
    let parent = node.parentElement
    while (parent && parent !== doc.documentElement) {
      if (/tomador|toma/i.test(parent.localName)) return true
      parent = parent.parentElement
    }
    return false
  })
  const company = first(doc, ['NomeTomador', 'xNomeTomador', 'RazaoSocialTomador', 'TomadorServico xNome', 'Tomador xNome'])
    || text(tomadorName)
    || byLocal(['xnometomador', 'nometomador', 'razaosocialtomador', 'nome'])
  const value = first(doc, ['ValorServicos', 'vServ', 'ValorLiquidoNfse', 'ValorLiquido', 'Valor'])
    || byLocal(['vserv', 'valorservicos', 'valorliquidonfse', 'valorliquido'])
  const dateValue = first(doc, ['DataEmissao', 'dhEmi', 'dataEmissao', 'Data'])
    || byLocal(['dhemi', 'dataemissao'])
  const description = first(doc, ['Discriminacao', 'xDescServ', 'DescricaoServico', 'Descricao'])
    || byLocal(['xdescserv', 'discriminacao', 'descricaoservico'])
  const number = first(doc, ['NumeroNfse', 'nNFSe', 'Numero', 'NumeroNota'])
    || byLocal(['nnfse', 'numeronfse', 'numeronota'])
  const amount = normalizeAmount(value)
  const issueDate = dateValue.slice(0, 10)
  if (!company || !amount || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || !description) {
    throw new Error('Não foi possível identificar todos os campos principais. Confira os dados e complete manualmente.')
  }
  const statusText = (byLocal(['situacaonfse', 'status', 'situacao']) || '').toLowerCase()
  const status: InvoiceStatus = /cancel/.test(statusText) ? 'cancelada' : /substitu/.test(statusText) ? 'substituida' : 'emitida'
  const base = { company_name: company, amount, issue_date: issueDate, description, invoice_number: number || null, status,
    source: 'xml' as const, replaced_by: null as string | null }
  return { ...base, fingerprint: fingerprint(base) }
}

export function parsePdfText(content: string): Partial<InvoiceDraft> {
  // Best-effort only: layouts vary widely. Always show this draft for user review.
  const amountMatch = content.match(/(?:valor(?:\s+(?:total|dos\s+servi[cç]os))?|total\s+dos\s+servi[cç]os)\s*[:\-]?\s*R?\$?\s*([\d.]+,\d{2})/i)
  const dateMatch = content.match(/(?:data\s+de\s+emiss[aã]o|emiss[aã]o)\s*[:\-]?\s*(\d{2})[/.](\d{2})[/.](\d{4})/i)
  const companyMatch = content.match(/(?:tomador(?:\s+do\s+servi[cç]o)?|raz[aã]o\s+social)\s*[:\-]?\s*([^\n\r]+)/i)
  const descMatch = content.match(/(?:discrimina[cç][aã]o|descri[cç][aã]o\s+do\s+servi[cç]o)\s*[:\-]?\s*([^\n\r]+)/i)
  const numberMatch = content.match(/(?:n[uú]mero\s+da\s+nota|n[uú]mero\s+nfse|NFS-e\s+n[ºo.]?\s*)\s*[:\-]?\s*([\w./-]+)/i)
  return {
    ...(amountMatch ? { amount: normalizeAmount(amountMatch[1]) } : {}),
    ...(dateMatch ? { issue_date: `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` } : {}),
    ...(companyMatch ? { company_name: companyMatch[1].trim() } : {}),
    ...(descMatch ? { description: descMatch[1].trim() } : {}),
    ...(numberMatch ? { invoice_number: numberMatch[1].trim() } : {}),
    source: 'pdf', status: 'emitida', replaced_by: null,
  }
}

export function makeDraft(fields: Omit<InvoiceDraft, 'fingerprint'>): InvoiceDraft {
  return { ...fields, fingerprint: fingerprint(fields) }
}
