import { describe, expect, it } from 'vitest'
import { makePaymentDraft, parsePaymentReceipt } from './payments'

describe('parsePaymentReceipt', () => {
  it('lê recebedor, valor e competência de um comprovante DAS', () => {
    const parsed = parsePaymentReceipt('Beneficiário: SIMPLES NACIONAL\nValor pago: R$ 76,90\nData do pagamento: 20/02/2026\nPeríodo de apuração: 01/2026', 'das', 'pdf')
    expect(parsed).toMatchObject({ recipient: 'SIMPLES NACIONAL', amount: 76.9, payment_date: '2026-02-20', reference_month: '2026-01-01', source: 'pdf' })
  })

  it('organiza gastos pelo mês da data de pagamento', () => {
    const parsed = parsePaymentReceipt('Favorecido: Loja de Material\nValor: R$ 1.234,56\nData do pagamento: 05/03/2026', 'gasto', 'imagem')
    expect(parsed).toMatchObject({ recipient: 'Loja de Material', amount: 1234.56, payment_date: '2026-03-05', reference_month: '2026-03-01', source: 'imagem' })
  })

  it('gera a mesma chave para pagamentos repetidos dos mesmos dados', () => {
    const base = { category: 'gasto' as const, recipient: 'Fornecedor A', amount: 15, payment_date: '2026-03-05', reference_month: '2026-03-01', source: 'manual' as const }
    expect(makePaymentDraft(base).fingerprint).toBe(makePaymentDraft({ ...base, recipient: ' fornecedor a ' }).fingerprint)
  })
})
