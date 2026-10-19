import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { createWorker } from 'tesseract.js'
import * as pdfjs from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { utils, writeFile } from 'xlsx'
import { configured, supabase } from './lib/supabase'
import { makeDraft, parseNfseXml, parsePdfText } from './lib/invoices'
import { makePaymentDraft, monthLabel, parsePaymentReceipt } from './lib/payments'
import type { Invoice, InvoiceDraft, InvoiceStatus, PaymentCategory, PaymentDraft, PaymentRecord, Settings } from './lib/types'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
type OcrWorker = Awaited<ReturnType<typeof createWorker>>
const thisYear = new Date().getFullYear()
const money = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)
const datePt = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString('pt-BR')
const initialSettings: Settings = { annual_limit: 81000, fiscal_year: thisYear, alert_percent: 80 }

export default function App() {
  const [session, setSession] = useState<any>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [register, setRegister] = useState(false)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [payments, setPayments] = useState<PaymentRecord[]>([])
  const [settings, setSettings] = useState(initialSettings)
  const [draft, setDraft] = useState<InvoiceDraft | null>(null)
  const [editing, setEditing] = useState<Invoice | null>(null)
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft | null>(null)
  const [editingPayment, setEditingPayment] = useState<PaymentRecord | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [canResendConfirmation, setCanResendConfirmation] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<'painel' | 'notas' | 'das' | 'gastos'>('painel')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  const loadData = useCallback(async () => {
    if (!supabase || !session?.user) return
    setLoading(true); setError('')
    const [invoiceResult, settingResult, paymentResult] = await Promise.all([
      supabase.from('invoices').select('*').order('issue_date', { ascending: false }),
      supabase.from('user_settings').select('*').maybeSingle(),
      supabase.from('payment_records').select('*').order('reference_month', { ascending: false }).order('payment_date', { ascending: false }),
    ])
    if (invoiceResult.error) setError(invoiceResult.error.message)
    else setInvoices(invoiceResult.data as Invoice[])
    if (settingResult.data) setSettings({ annual_limit: Number(settingResult.data.annual_limit), fiscal_year: settingResult.data.fiscal_year, alert_percent: settingResult.data.alert_percent })
    if (paymentResult.error) setError(paymentResult.error.message)
    else setPayments(paymentResult.data as PaymentRecord[])
    setLoading(false)
  }, [session])

  useEffect(() => { void loadData() }, [loadData])

  const yearInvoices = useMemo(() => invoices.filter(i => new Date(`${i.issue_date}T12:00:00`).getFullYear() === settings.fiscal_year && i.status === 'emitida'), [invoices, settings.fiscal_year])
  const total = yearInvoices.reduce((sum, i) => sum + Number(i.amount), 0)
  const remaining = settings.annual_limit - total
  const percent = settings.annual_limit > 0 ? total / settings.annual_limit * 100 : 0
  const visible = invoices.filter(i => `${i.company_name} ${i.description} ${i.invoice_number ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const visiblePayments = payments.filter(p => p.category === (tab === 'das' ? 'das' : 'gasto') && p.reference_month.startsWith(`${settings.fiscal_year}-`) && `${p.recipient} ${p.reference_month}`.toLowerCase().includes(query.toLowerCase()))
  const totalPayments = visiblePayments.reduce((sum, p) => sum + Number(p.amount), 0)

  async function authSubmit(e: FormEvent) {
    e.preventDefault(); if (!supabase) return
    setError(''); setNotice('')
    const result = register ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password })
    if (result.error) {
      setError(result.error.message)
      const code = (result.error as { code?: string }).code
      if (code === 'email_not_confirmed' || code === 'user_already_exists' || code === 'email_exists') setCanResendConfirmation(true)
    }
    else if (register && !result.data.session) {
      setCanResendConfirmation(true)
      setNotice('Solicitação de cadastro aceita. Confirme seu e-mail pelo link enviado para entrar.')
    }
  }

  async function signInWithGoogle() {
    if (!supabase) return
    setError(''); setNotice('')
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}` },
    })
    if (oauthError) setError(oauthError.message)
  }

  async function resendConfirmation() {
    if (!supabase || !email.trim()) return
    setError(''); setNotice('')
    const { error: resendError } = await supabase.auth.resend({ type: 'signup', email: email.trim() })
    if (resendError) setError(resendError.message)
    else setNotice('Solicitação de reenvio enviada. Confira sua caixa de entrada e a pasta de spam.')
  }

  async function saveInvoice(e: FormEvent) {
    e.preventDefault(); if (!supabase || !session?.user || !draft) return
    const prepared = makeDraft({ ...draft, amount: Number(draft.amount), company_name: draft.company_name.trim(), description: draft.description.trim(), invoice_number: draft.invoice_number?.trim() || null })
    if (!prepared.company_name || !prepared.description || !prepared.issue_date || prepared.amount <= 0) { setError('Preencha tomador, data, descrição e um valor maior que zero.'); return }
    setError('')
    const result = editing
      ? await supabase.from('invoices').update(prepared).eq('id', editing.id).select().single()
      : await supabase.from('invoices').insert({ ...prepared, user_id: session.user.id }).select().single()
    if (result.error) {
      setError(result.error.code === '23505' ? 'Esta nota já foi cadastrada. A deduplicação encontrou uma nota com os mesmos dados.' : result.error.message)
      return
    }
    setDraft(null); setEditing(null); setNotice(editing ? 'Nota atualizada.' : 'Nota salva.'); await loadData()
  }

  async function importFile(file?: File) {
    if (!file) return
    setError(''); setNotice('')
    try {
      let parsed: Partial<InvoiceDraft>
      if (file.name.toLowerCase().endsWith('.xml')) parsed = parseNfseXml(await file.text())
      else if (file.name.toLowerCase().endsWith('.pdf')) {
        const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
        const pages: string[] = []
        for (let n = 1; n <= doc.numPages; n++) { const page = await doc.getPage(n); const content = await page.getTextContent(); pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' ')) }
        parsed = parsePdfText(pages.join('\n'))
      } else throw new Error('Selecione um arquivo XML ou PDF.')
      const base = { company_name: parsed.company_name ?? '', amount: parsed.amount ?? 0, issue_date: parsed.issue_date ?? '', description: parsed.description ?? '', invoice_number: parsed.invoice_number ?? null,
        status: parsed.status ?? 'emitida', source: parsed.source ?? 'pdf', replaced_by: null }
      setDraft(makeDraft(base as Omit<InvoiceDraft, 'fingerprint'>)); setEditing(null)
      setNotice(file.name.toLowerCase().endsWith('.pdf') ? 'PDF extraído quando possível. Confira e corrija todos os campos antes de salvar.' : 'Confira os campos importados antes de salvar.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível ler o arquivo.') }
  }

  async function importPaymentReceipt(file: File | undefined, category: PaymentCategory) {
    if (!file) return
    setError(''); setNotice('')
    try {
      let extractedText = ''
      const source = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' as const : 'imagem' as const
      const workerRef: { current?: OcrWorker } = {}
      const getWorker = async () => {
        if (!workerRef.current) { const { createWorker } = await import('tesseract.js'); workerRef.current = await createWorker('por') }
        return workerRef.current
      }
      try {
        if (source === 'pdf') {
          const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
          const textPages: string[] = []
          for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
            const page = await doc.getPage(n)
            const content = await page.getTextContent()
            const pageText = content.items.map(item => 'str' in item ? item.str : '').join(' ')
            textPages.push(pageText)
            if (pageText.trim().length < 20) {
              const viewport = page.getViewport({ scale: 1.6 })
              const canvas = document.createElement('canvas')
              canvas.width = viewport.width; canvas.height = viewport.height
              const context = canvas.getContext('2d')
              if (!context) throw new Error('Não foi possível preparar o PDF para leitura.')
              await page.render({ canvasContext: context, viewport }).promise
              textPages.push((await (await getWorker()).recognize(canvas)).data.text)
            }
          }
          extractedText = textPages.join('\n')
        } else extractedText = (await (await getWorker()).recognize(file)).data.text
      } finally { if (workerRef.current) await workerRef.current.terminate() }
      const parsed = parsePaymentReceipt(extractedText, category, source)
      const today = new Date().toISOString().slice(0, 10)
      const paidDate = parsed.payment_date || today
      const month = parsed.reference_month || `${paidDate.slice(0, 7)}-01`
      const base = { category, recipient: parsed.recipient ?? '', amount: parsed.amount ?? 0, payment_date: paidDate, reference_month: month, source }
      setPaymentDraft(makePaymentDraft(base)); setEditingPayment(null)
      setNotice('A leitura do comprovante é automática e aproximada. Revise recebedor, valor, data e mês antes de salvar. O arquivo é processado no navegador e não é enviado ao servidor.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível ler o comprovante.') }
  }

  async function savePayment(e: FormEvent) {
    e.preventDefault(); if (!supabase || !session?.user || !paymentDraft) return
    const paidDate = paymentDraft.payment_date
    const month = `${paymentDraft.reference_month.slice(0, 7)}-01`
    const prepared = makePaymentDraft({ ...paymentDraft, recipient: paymentDraft.recipient.trim(), amount: Number(paymentDraft.amount), payment_date: paidDate, reference_month: month })
    if (!prepared.recipient || prepared.amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(paidDate) || !/^\d{4}-\d{2}-01$/.test(month)) { setError('Confira recebedor, valor, data e mês antes de salvar.'); return }
    const result = editingPayment
      ? await supabase.from('payment_records').update(prepared).eq('id', editingPayment.id).select().single()
      : await supabase.from('payment_records').insert({ ...prepared, user_id: session.user.id }).select().single()
    if (result.error) {
      setError(result.error.code === '23505' ? 'Este comprovante já foi cadastrado para esse mês. Confira a lista por mês.' : result.error.message)
      return
    }
    setPaymentDraft(null); setEditingPayment(null); setNotice(editingPayment ? 'Pagamento atualizado.' : 'Pagamento salvo.'); await loadData()
  }

  function openPaymentEditor(row?: PaymentRecord, category: PaymentCategory = tab === 'das' ? 'das' : 'gasto') {
    const today = new Date().toISOString().slice(0, 10)
    const base = row ? { category: row.category, recipient: row.recipient, amount: row.amount, payment_date: row.payment_date, reference_month: row.reference_month, source: row.source }
      : { category, recipient: '', amount: 0, payment_date: today, reference_month: `${today.slice(0, 7)}-01`, source: 'manual' as const }
    setPaymentDraft(makePaymentDraft(base)); setEditingPayment(row ?? null); setError(''); setNotice('')
  }

  async function removePayment(row: PaymentRecord) {
    if (!supabase || !window.confirm(`Excluir o pagamento de ${row.recipient}?`)) return
    const { error: removeError } = await supabase.from('payment_records').delete().eq('id', row.id)
    if (removeError) setError(removeError.message)
    else { setNotice('Pagamento excluído.'); await loadData() }
  }

  async function updateStatus(row: Invoice, status: InvoiceStatus) {
    if (!supabase) return
    const { error: updateError } = await supabase.from('invoices').update({ status }).eq('id', row.id)
    if (updateError) setError(updateError.message); else await loadData()
  }

  async function removeInvoice(row: Invoice) {
    if (!supabase || !window.confirm(`Excluir a nota de ${row.company_name}?`)) return
    const { error: removeError } = await supabase.from('invoices').delete().eq('id', row.id)
    if (removeError) setError(removeError.message); else { setNotice('Nota excluída.'); await loadData() }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault(); if (!supabase || !session?.user) return
    const { error: saveError } = await supabase.from('user_settings').upsert({ user_id: session.user.id, ...settings })
    if (saveError) setError(saveError.message); else setNotice('Preferências salvas.')
  }

  function exportExcel() {
    const rows = yearInvoices.map(i => ({ 'Nome da empresa / tomador': i.company_name, Valor: Number(i.amount), Data: datePt(i.issue_date), 'Descrição do serviço': i.description, 'Número da NFS-e': i.invoice_number ?? '', Status: i.status }))
    const summary = [{ 'Ano fiscal': settings.fiscal_year, 'Teto configurado': settings.annual_limit, 'Total de notas emitidas': total, 'Saldo restante': remaining, 'Percentual utilizado': `${percent.toFixed(2)}%`, 'Notas emitidas': yearInvoices.length }]
    const book = utils.book_new(); utils.book_append_sheet(book, utils.json_to_sheet(summary), 'Resumo'); utils.book_append_sheet(book, utils.json_to_sheet(rows), 'Notas emitidas')
    writeFile(book, `relatorio-nfse-${settings.fiscal_year}.xlsx`)
  }

  function openEditor(row?: Invoice) {
    const base = row ? { company_name: row.company_name, amount: row.amount, issue_date: row.issue_date, description: row.description, invoice_number: row.invoice_number, status: row.status, source: row.source, replaced_by: row.replaced_by } : { company_name: '', amount: 0, issue_date: new Date().toISOString().slice(0, 10), description: '', invoice_number: null, status: 'emitida' as const, source: 'manual' as const, replaced_by: null }
    setDraft(makeDraft(base)); setEditing(row ?? null); setError('')
  }

  const pageTitle = tab === 'painel' ? 'Visão geral' : tab === 'notas' ? 'Minhas notas' : tab === 'das' ? 'DAS pagas' : 'Gastos do MEI'
  const paymentCategory: PaymentCategory = tab === 'das' ? 'das' : 'gasto'

  if (!configured || !supabase) return <main className="setup"><span className="eyebrow">NOTAS MEI</span><h1>Seu controle começa aqui.</h1><p>Antes de usar, conecte o projeto ao Supabase. As etapas estão no README.</p><div className="setup-card"><b>Configuração necessária</b><ol><li>Crie o projeto Supabase e execute <code>supabase/schema.sql</code>.</li><li>Copie <code>.env.example</code> para <code>.env.local</code> e informe URL e chave pública.</li><li>Reinicie o site com <code>npm run dev</code>.</li></ol></div></main>

  if (!session) return <main className="auth-shell"><section className="auth-art"><span className="eyebrow">NOTAS MEI</span><div><p className="eyebrow">SEU NEGÓCIO, EM FOCO</p><h1>Organize suas notas.<br/>Acompanhe seu ano.</h1><p>Um lugar simples para cuidar do seu faturamento de serviços.</p></div><div className="auth-art-foot">Seu painel financeiro, sempre à mão.</div></section><section className="auth-form-wrap"><form className="auth-form" onSubmit={authSubmit}><span className="eyebrow">BEM-VINDO</span><h2>{register ? 'Crie sua conta' : 'Entre na sua conta'}</h2><p>Suas informações são privadas e protegidas.</p><button type="button" className="secondary full oauth-button" onClick={() => void signInWithGoogle()}><b aria-hidden="true">G</b> Continuar com Google</button><div className="auth-divider"><span>ou com e-mail</span></div><label>E-mail<input required type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="voce@exemplo.com" /></label><label>Senha<input required minLength={6} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mínimo de 6 caracteres" /></label><button className="primary full">{register ? 'Criar conta' : 'Entrar'}</button><button type="button" className="text-button" onClick={() => { setRegister(!register); setCanResendConfirmation(false); setError(''); setNotice('') }}>{register ? 'Já tem conta? Entrar' : 'Ainda não tem conta? Criar conta'}</button>{error && <p className="error">{error}</p>}{notice && <p className="notice">{notice}</p>}{canResendConfirmation && <button type="button" className="text-button" onClick={() => void resendConfirmation()}>Reenviar e-mail de confirmação</button>}</form></section></main>

  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#"><span className="brand-icon">N</span><span>notas<span className="brand-light">mei</span></span></a><div className="side-label">ESPAÇO DE TRABALHO</div><button className={tab === 'painel' ? 'nav active' : 'nav'} onClick={() => setTab('painel')}><span>▦</span> Visão geral</button><button className={tab === 'notas' ? 'nav active' : 'nav'} onClick={() => setTab('notas')}><span>▤</span> Minhas notas</button><button className={tab === 'das' ? 'nav active' : 'nav'} onClick={() => setTab('das')}><span>▣</span> DAS pagas</button><button className={tab === 'gastos' ? 'nav active' : 'nav'} onClick={() => setTab('gastos')}><span>▧</span> Gastos do MEI</button><div className="side-user"><div className="avatar">{session.user.email?.[0].toUpperCase()}</div><div className="user-detail"><b>{session.user.email}</b><small>Conta pessoal</small></div><button className="icon-button" title="Sair" onClick={() => void supabase?.auth.signOut()}>↗</button></div></aside>
    <main className="main"><header className="topbar"><div><span className="eyebrow">PAINEL FINANCEIRO</span><div className="breadcrumb">Meu negócio <span>/</span> {pageTitle}</div></div><div className="top-actions"><span className="year-pill">● &nbsp;Exercício {settings.fiscal_year}</span>{tab === 'notas' && <button className="primary" onClick={() => openEditor()}>＋ Nova nota</button>}{(tab === 'das' || tab === 'gastos') && <button className="primary" onClick={() => openPaymentEditor(undefined, paymentCategory)}>＋ Novo pagamento</button>}</div></header>
      <div className="content"><div className="welcome"><div><p className="eyebrow">{tab === 'painel' ? 'ACOMPANHAMENTO ANUAL' : tab === 'notas' ? 'DOCUMENTOS FISCAIS' : tab === 'das' ? 'TRIBUTOS DO MEI' : 'DESPESAS DO NEGÓCIO'}</p><h1>{pageTitle}</h1><p>{tab === 'painel' ? 'Acompanhe suas emissões e o saldo do seu limite configurado.' : tab === 'notas' ? 'Consulte, importe e organize suas notas de serviço.' : tab === 'das' ? 'Organize os comprovantes de DAS pagos por mês.' : 'Acompanhe os gastos do MEI pelos comprovantes bancários.'}</p></div>{tab === 'notas' && <div className="import-actions"><label className="secondary upload">↑ Importar XML<input type="file" accept=".xml,text/xml,application/xml" onChange={e => void importFile(e.target.files?.[0])}/></label><label className="secondary upload">↑ Importar PDF<input type="file" accept=".pdf,application/pdf" onChange={e => void importFile(e.target.files?.[0])}/></label></div>}{(tab === 'das' || tab === 'gastos') && <div className="import-actions"><label className="secondary upload">↑ Ler comprovante<input type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={e => void importPaymentReceipt(e.target.files?.[0], paymentCategory)}/></label></div>}</div>
      {error && <div className="message error">{error}<button onClick={() => setError('')}>×</button></div>}{notice && <div className="message notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
      {tab === 'painel' ? <><div className="stat-grid"><article className="stat-card"><span className="stat-title">TOTAL EMITIDO NO ANO <span className="stat-icon green">↗</span></span><strong>{money(total)}</strong><small>{yearInvoices.length} {yearInvoices.length === 1 ? 'nota emitida' : 'notas emitidas'}</small></article><article className="stat-card"><span className="stat-title">LIMITE ANUAL CONFIGURADO <span className="stat-icon">◎</span></span><strong>{money(settings.annual_limit)}</strong><small>Exercício fiscal de {settings.fiscal_year}</small></article><article className="stat-card"><span className="stat-title">SALDO RESTANTE <span className="stat-icon blue">⌁</span></span><strong className={remaining < 0 ? 'negative' : ''}>{money(remaining)}</strong><small>Com base nas notas emitidas</small></article></div>
      <div className="dashboard-grid"><section className="panel limit-panel"><div className="panel-heading"><div><h2>Uso do limite</h2><p>Faturamento emitido no exercício</p></div><span className="progress-percent">{percent.toFixed(1)}%</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}/></div><div className="progress-legend"><span><i className="dot green-dot"/> Emitido <b>{money(total)}</b></span><span><i className="dot gray-dot"/> Restante <b>{money(remaining)}</b></span></div>{percent >= settings.alert_percent && <p className="alert">Você atingiu o limite de alerta configurado ({settings.alert_percent}%).</p>}{remaining < 0 && <p className="alert">O total informado ultrapassou o limite configurado.</p>}<div className="monthly"><h3>Emissões por mês</h3><MonthlyBars invoices={yearInvoices}/></div></section>
      <section className="panel settings-panel"><div className="panel-heading"><div><h2>Preferências</h2><p>Configure seu acompanhamento anual</p></div><span className="settings-icon">⚙</span></div><form onSubmit={saveSettings} className="settings-form"><label>Ano fiscal<input type="number" min="2000" max="2100" value={settings.fiscal_year} onChange={e => setSettings({ ...settings, fiscal_year: Number(e.target.value) })}/></label><label>Limite anual (R$)<input type="number" min="0" step="0.01" value={settings.annual_limit} onChange={e => setSettings({ ...settings, annual_limit: Number(e.target.value) })}/></label><label>Alerta a partir de (%)<input type="number" min="1" max="100" value={settings.alert_percent} onChange={e => setSettings({ ...settings, alert_percent: Number(e.target.value) })}/></label><button className="secondary full">Salvar preferências</button></form><p className="fine-print">O limite é uma referência configurável. Verifique as regras oficiais aplicáveis ao seu caso e ao ano fiscal selecionado.</p></section></div>
      <section className="panel recent-panel"><div className="panel-heading"><div><h2>Notas recentes</h2><p>As últimas notas fiscais cadastradas</p></div><button className="text-button" onClick={() => setTab('notas')}>Ver todas →</button></div><InvoiceTable rows={invoices.slice(0, 5)} onEdit={openEditor} onDelete={removeInvoice} onStatus={updateStatus}/></section></>
      : tab === 'notas' ? <section className="panel all-invoices"><div className="panel-heading"><div><h2>Notas fiscais</h2><p>{invoices.length} registros · notas emitidas no ano selecionado: {money(total)}</p></div><button className="secondary" onClick={exportExcel}>↓ Exportar Excel</button></div><div className="filters"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar empresa, descrição ou número..."/><span>{loading ? 'Atualizando…' : `${visible.length} notas`}</span></div><InvoiceTable rows={visible} onEdit={openEditor} onDelete={removeInvoice} onStatus={updateStatus}/></section>
      : <PaymentLedger category={paymentCategory} rows={visiblePayments} total={totalPayments} year={settings.fiscal_year} query={query} loading={loading} onQuery={setQuery} onNew={() => openPaymentEditor(undefined, paymentCategory)} onEdit={row => openPaymentEditor(row)} onDelete={removePayment} onImport={file => void importPaymentReceipt(file, paymentCategory)}/>}
      <footer className="footer">Notas MEI <span>•</span> seus dados sincronizados com segurança</footer></div>
    </main>
    {draft && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) { setDraft(null); setEditing(null) } }}><form className="modal" onSubmit={saveInvoice}><div className="modal-head"><div><span className="eyebrow">{editing ? 'EDITAR REGISTRO' : `NOVA NOTA · ${draft.source.toUpperCase()}`}</span><h2>{editing ? 'Editar nota fiscal' : 'Revise os dados da nota'}</h2></div><button type="button" className="icon-button" onClick={() => { setDraft(null); setEditing(null) }}>×</button></div><p className="modal-note">{draft.source === 'pdf' ? 'A leitura de PDF é aproximada. Confirme cada campo antes de salvar.' : draft.source === 'xml' ? 'Confira os dados extraídos do XML antes de salvar.' : 'Preencha os dados da nota emitida.'}</p><label>Empresa / tomador<input required value={draft.company_name} onChange={e => setDraft({ ...draft, company_name: e.target.value })}/></label><div className="form-row"><label>Valor (R$)<input required type="number" step="0.01" min="0.01" value={draft.amount || ''} onChange={e => setDraft({ ...draft, amount: Number(e.target.value) })}/></label><label>Data de emissão<input required type="date" value={draft.issue_date} onChange={e => setDraft({ ...draft, issue_date: e.target.value })}/></label></div><label>Número da NFS-e<input value={draft.invoice_number ?? ''} onChange={e => setDraft({ ...draft, invoice_number: e.target.value || null })} placeholder="Opcional"/></label><label>Descrição do serviço<textarea required rows={3} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><label>Status<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as InvoiceStatus })}><option value="emitida">Emitida</option><option value="cancelada">Cancelada</option><option value="substituida">Substituída</option></select></label><div className="modal-actions"><button type="button" className="secondary" onClick={() => { setDraft(null); setEditing(null) }}>Cancelar</button><button className="primary">{editing ? 'Salvar alterações' : 'Salvar nota'}</button></div>{error && <p className="error">{error}</p>}</form></div>}
    {draft && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) { setDraft(null); setEditing(null) } }}><form className="modal" onSubmit={saveInvoice}><div className="modal-head"><div><span className="eyebrow">{editing ? 'EDITAR REGISTRO' : `NOVA NOTA · ${draft.source.toUpperCase()}`}</span><h2>{editing ? 'Editar nota fiscal' : 'Revise os dados da nota'}</h2></div><button type="button" className="icon-button" onClick={() => { setDraft(null); setEditing(null) }}>×</button></div><p className="modal-note">{draft.source === 'pdf' ? 'A leitura de PDF é aproximada. Confirme cada campo antes de salvar.' : draft.source === 'xml' ? 'Confira os dados importados antes de salvar.' : 'Preencha os dados da nota emitida.'}</p><label>Empresa / tomador<input required value={draft.company_name} onChange={e => setDraft({ ...draft, company_name: e.target.value })}/></label><div className="form-row"><label>Valor (R$)<input required type="number" step="0.01" min="0.01" value={draft.amount || ''} onChange={e => setDraft({ ...draft, amount: Number(e.target.value) })}/></label><label>Data de emissão<input required type="date" value={draft.issue_date} onChange={e => setDraft({ ...draft, issue_date: e.target.value })}/></label></div><label>Número da NFS-e<input value={draft.invoice_number ?? ''} onChange={e => setDraft({ ...draft, invoice_number: e.target.value || null })} placeholder="Opcional"/></label><label>Descrição do serviço<textarea required rows={3} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><label>Status<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as InvoiceStatus })}><option value="emitida">Emitida</option><option value="cancelada">Cancelada</option><option value="substituida">Substituída</option></select></label><div className="modal-actions"><button type="button" className="secondary" onClick={() => { setDraft(null); setEditing(null) }}>Cancelar</button><button className="primary">{editing ? 'Salvar alterações' : 'Salvar nota'}</button></div>{error && <p className="error">{error}</p>}</form></div>}
    {paymentDraft && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) { setPaymentDraft(null); setEditingPayment(null) } }}><form className="modal" onSubmit={savePayment}><div className="modal-head"><div><span className="eyebrow">{editingPayment ? 'EDITAR PAGAMENTO' : paymentDraft.source === 'manual' ? 'CADASTRO MANUAL' : `COMPROVANTE · ${paymentDraft.source.toUpperCase()}`}</span><h2>{editingPayment ? 'Editar pagamento' : paymentDraft.category === 'das' ? 'Revise o DAS pago' : 'Revise o gasto do MEI'}</h2></div><button type="button" className="icon-button" onClick={() => { setPaymentDraft(null); setEditingPayment(null) }}>×</button></div><p className="modal-note">A extração é aproximada. Confira os dados antes de salvar. Arquivos de comprovante são processados no seu navegador e não ficam armazenados no app.</p><label>Recebedor<input required value={paymentDraft.recipient} onChange={e => setPaymentDraft(makePaymentDraft({ ...paymentDraft, recipient: e.target.value }))} placeholder="Nome do recebedor ou favorecido"/></label><div className="form-row"><label>Valor pago (R$)<input required type="number" step="0.01" min="0.01" value={paymentDraft.amount || ''} onChange={e => setPaymentDraft(makePaymentDraft({ ...paymentDraft, amount: Number(e.target.value) }))}/></label><label>Data do pagamento<input required type="date" value={paymentDraft.payment_date} onChange={e => { const day = e.target.value; setPaymentDraft(makePaymentDraft({ ...paymentDraft, payment_date: day, reference_month: paymentDraft.category === 'gasto' && day ? `${day.slice(0, 7)}-01` : paymentDraft.reference_month })) }}/></label></div><label>{paymentDraft.category === 'das' ? 'Mês de referência do DAS' : 'Mês do pagamento'}<input required type="month" value={paymentDraft.reference_month.slice(0, 7)} onChange={e => setPaymentDraft(makePaymentDraft({ ...paymentDraft, reference_month: `${e.target.value}-01` }))}/></label><div className="modal-actions"><button type="button" className="secondary" onClick={() => { setPaymentDraft(null); setEditingPayment(null) }}>Cancelar</button><button className="primary">{editingPayment ? 'Salvar alterações' : 'Salvar pagamento'}</button></div>{error && <p className="error">{error}</p>}</form></div>}
  </div>
}

function MonthlyBars({ invoices }: { invoices: Invoice[] }) {
  const values = Array(12).fill(0) as number[]
  invoices.forEach(i => { values[Number(i.issue_date.slice(5, 7)) - 1] += Number(i.amount) })
  const max = Math.max(...values, 1)
  return <div className="chart">{values.map((value, i) => <div className="bar-column" key={i} title={`${new Date(2000, i).toLocaleString('pt-BR', { month: 'long' })}: ${money(value)}`}><div className={value ? 'bar filled' : 'bar'} style={{ height: `${Math.max(value / max * 100, 3)}%` }}/><small>{'JFMAMJJASOND'[i]}</small></div>)}</div>
}

function InvoiceTable({ rows, onEdit, onDelete, onStatus }: { rows: Invoice[]; onEdit: (i: Invoice) => void; onDelete: (i: Invoice) => void; onStatus: (i: Invoice, s: InvoiceStatus) => void }) {
  if (!rows.length) return <div className="empty"><span>▤</span><b>Nenhuma nota por aqui</b><p>Cadastre manualmente ou importe um XML/PDF para começar.</p></div>
  return <div className="table-wrap"><table><thead><tr><th>EMPRESA / TOMADOR</th><th>DATA</th><th>DESCRIÇÃO</th><th>VALOR</th><th>STATUS</th><th></th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><b>{row.company_name}</b>{row.invoice_number && <small>#{row.invoice_number}</small>}</td><td>{datePt(row.issue_date)}</td><td className="description-cell">{row.description}</td><td className="amount-cell">{money(Number(row.amount))}</td><td><select aria-label={`Status da nota de ${row.company_name}`} className={`status status-${row.status}`} value={row.status} onChange={e => onStatus(row, e.target.value as InvoiceStatus)}><option value="emitida">Emitida</option><option value="cancelada">Cancelada</option><option value="substituida">Substituída</option></select></td><td className="row-actions"><button title="Editar" onClick={() => onEdit(row)}>✎</button><button title="Excluir" onClick={() => onDelete(row)}>×</button></td></tr>)}</tbody></table></div>
}

function PaymentLedger({ category, rows, total, year, query, loading, onQuery, onNew, onEdit, onDelete, onImport }: {
  category: PaymentCategory; rows: PaymentRecord[]; total: number; year: number; query: string; loading: boolean
  onQuery: (value: string) => void; onNew: () => void; onEdit: (row: PaymentRecord) => void
  onDelete: (row: PaymentRecord) => void; onImport: (file?: File) => void
}) {
  const grouped = rows.reduce<Record<string, PaymentRecord[]>>((acc, row) => {
    (acc[row.reference_month] ??= []).push(row)
    return acc
  }, {})
  const orderedMonths = Object.keys(grouped).sort((a, b) => b.localeCompare(a))
  return <section className="panel all-invoices payment-ledger"><div className="payment-summary"><div><span className="eyebrow">TOTAL {category === 'das' ? 'DAS PAGOS' : 'GASTOS REGISTRADOS'}</span><strong>{money(total)}</strong><small>{rows.length} {rows.length === 1 ? 'pagamento' : 'pagamentos'} em {year}</small></div><div className="payment-actions"><button className="secondary" onClick={onNew}>＋ Cadastro manual</button><label className="secondary upload">↑ Ler comprovante<input type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={e => { onImport(e.target.files?.[0]); e.target.value = '' }}/></label></div></div><div className="filters"><input value={query} onChange={e => onQuery(e.target.value)} placeholder="Buscar recebedor..."/><span>{loading ? 'Atualizando…' : `${rows.length} registros`}</span></div>
    {!rows.length ? <div className="empty"><span>▤</span><b>Nenhum pagamento registrado em {year}</b><p>Importe um comprovante PDF, PNG ou JPG ou cadastre o pagamento manualmente.</p></div> : <div className="payment-months">{orderedMonths.map(month => <section className="payment-month" key={month}><div className="payment-month-heading"><h2>{monthLabel(month)}</h2><b>{money(grouped[month].reduce((sum, row) => sum + Number(row.amount), 0))}</b></div><div className="table-wrap"><table><thead><tr><th>RECEBEDOR</th><th>DATA DO PAGAMENTO</th><th>MÊS</th><th>VALOR PAGO</th><th>ORIGEM</th><th></th></tr></thead><tbody>{grouped[month].map(row => <tr key={row.id}><td><b>{row.recipient}</b></td><td>{datePt(row.payment_date)}</td><td>{monthLabel(row.reference_month)}</td><td className="amount-cell">{money(Number(row.amount))}</td><td><small className="source-tag">{row.source === 'manual' ? 'Manual' : row.source === 'pdf' ? 'PDF' : 'Imagem'}</small></td><td className="row-actions"><button title="Editar" onClick={() => onEdit(row)}>✎</button><button title="Excluir" onClick={() => onDelete(row)}>×</button></td></tr>)}</tbody></table></div></section>)}</div>}
  </section>
}
