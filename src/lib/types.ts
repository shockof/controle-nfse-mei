export type InvoiceStatus = 'emitida' | 'cancelada' | 'substituida'
export type Invoice = {
  id: string
  user_id: string
  company_name: string
  amount: number
  issue_date: string
  description: string
  invoice_number: string | null
  status: InvoiceStatus
  source: 'manual' | 'xml' | 'pdf'
  fingerprint: string
  replaced_by: string | null
  created_at: string
}
export type InvoiceDraft = Omit<Invoice, 'id' | 'user_id' | 'created_at'>
export type Settings = { annual_limit: number; fiscal_year: number; alert_percent: number }
