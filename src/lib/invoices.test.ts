import { describe, expect, it } from 'vitest'
import { fingerprint, normalizeAmount, parseNfseXml } from './invoices'

describe('normalização e importação de NFS-e', () => {
  it('interpreta valores no padrão brasileiro', () => {
    expect(normalizeAmount('R$ 1.234,56')).toBe(1234.56)
    expect(normalizeAmount('95,00')).toBe(95)
  })

  it('extrai dados de um XML comum e detecta status cancelado', () => {
    const xml = `<CompNfse><Prestador><xNome>Prestador Correto</xNome></Prestador><Nfse><InfNfse><Numero>42</Numero><DataEmissao>2026-03-14T10:00:00</DataEmissao><ValorServicos>250,50</ValorServicos><TomadorServico><IdentificacaoTomador><CpfCnpj>123</CpfCnpj></IdentificacaoTomador><RazaoSocialTomador>Cliente Exemplo Ltda</RazaoSocialTomador></TomadorServico><Discriminacao>Consultoria técnica</Discriminacao><SituacaoNfse>Cancelada</SituacaoNfse></InfNfse></Nfse></CompNfse>`
    const result = parseNfseXml(xml)
    expect(result.company_name).toBe('Cliente Exemplo Ltda')
    expect(result.amount).toBe(250.5)
    expect(result.issue_date).toBe('2026-03-14')
    expect(result.status).toBe('cancelada')
  })

  it('finds the tomador in the national NFS-e toma structure', () => {
    const xml = `<NFSe><nNFSe>88</nNFSe><dhEmi>2026-07-03T09:00:00</dhEmi><vServ>85.00</vServ><prest><xNome>Prestador Exemplo</xNome></prest><toma><xNome>Tomador Nacional</xNome></toma><xDescServ>Suporte mensal</xDescServ></NFSe>`
    expect(parseNfseXml(xml).company_name).toBe('Tomador Nacional')
  })

  it('produces the same deduplication key for equivalent records', () => {
    const a = { company_name: 'Cliente A', amount: 20, issue_date: '2026-01-01', invoice_number: '7' }
    const b = { company_name: 'cliente a', amount: 20, issue_date: '2026-01-01', invoice_number: '7' }
    expect(fingerprint(a)).toBe(fingerprint(b))
  })

  it('rejects malformed or incomplete XML', () => {
    expect(() => parseNfseXml('<nota>sem dados</nota>')).toThrow()
  })
})
