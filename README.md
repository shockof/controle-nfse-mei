# Notas MEI — controle de NFS-e

Aplicação web para acompanhar notas fiscais de serviço por conta, com painel anual, importação de XML/PDF, cadastro manual, edição, exclusão e exportação Excel. O frontend é estático (Vite + React) e pode ser publicado no GitHub Pages. Supabase fornece autenticação e banco de dados PostgreSQL com Row Level Security (RLS).

## Funcionalidades

- Contas individuais por e-mail e senha, Google ou Apple (Supabase Auth; provedores sociais dependem de credenciais OAuth configuradas).
- Dados de notas e preferências isolados por usuário via políticas RLS.
- Dashboard com total emitido, limite anual configurável, saldo e percentual utilizado.
- Gráfico de barras com valores por mês e alerta configurável.
- Cadastro manual, importação XML e leitura best-effort de PDF com tela de revisão antes de gravar.
- Edição, exclusão e status emitida, cancelada ou substituída; notas canceladas/substituídas não entram no total.
- Deduplicação por número da nota + tomador + data + valor; quando não há número, usa tomador + data + valor.
- Exportação `.xlsx` com aba de resumo e aba de notas contendo nome do tomador, valor, data, descrição, número e status.

O teto padrão de R$ 81.000 é apenas um valor inicial editável, não uma declaração da regra vigente. Confira as regras oficiais aplicáveis à sua situação e ao exercício fiscal. O sistema soma as notas com status “Emitida” dentro do ano escolhido; consulte um profissional para definir corretamente o tratamento do faturamento.

## Requisitos

- Node.js 20+ e pnpm 9.15.4 (ou Corepack para ativar a versão declarada no projeto).
- Uma conta/projeto Supabase criado pelo usuário.
- Um repositório GitHub já criado pelo usuário para publicação. Este projeto não cria repositórios nem configura serviços externos.

## Configurar Supabase

1. No Supabase, crie um projeto e aguarde o provisionamento.
2. Abra **SQL Editor**, crie uma consulta e execute o conteúdo de [`supabase/schema.sql`](supabase/schema.sql). Isso cria as tabelas `invoices` e `user_settings`, índices, constraints e políticas RLS.
3. Em **Project Settings → API**, copie a Project URL e a chave pública `anon` (ou `publishable`). Nunca use `service_role` no navegador.
4. Em **Authentication → URL Configuration**, adicione a URL local `http://localhost:5173` e a URL de produção do GitHub Pages à lista de URLs permitidas. Configure também o Site URL de produção.
5. Em **Authentication → Providers → Email**, mantenha o provedor por e-mail habilitado. Se a confirmação de e-mail estiver ativa, confirme a conta pelo link enviado antes de entrar.
6. Para **Google**, configure OAuth Client ID e Client Secret em **Authentication → Sign In / Providers → Google**. No Google Cloud Console, crie um OAuth Client do tipo Web, inclua `https://shockof.github.io` como origem autorizada e o callback exibido pelo Supabase como URI de redirecionamento autorizado (normalmente `https://<project-ref>.supabase.co/auth/v1/callback`). O Google já aparece habilitado neste projeto, mas confirme que Client ID e Secret estão preenchidos e salvos.
7. Para **Apple**, configure o provedor em **Authentication → Sign In / Providers → Apple**. É necessário criar um Services ID, configurar o domínio de retorno e callback mostrados pelo Supabase no Apple Developer e fornecer Team ID, Key ID e a chave privada Sign in with Apple. A criação dessas credenciais depende de acesso à conta Apple Developer; não use a senha do Apple ID como segredo OAuth.
8. Os botões Google e Apple retornam ao GitHub Pages após autenticação. Mantenha `https://shockof.github.io/controle-nfse-mei/` na lista de URLs permitidas em **Authentication → URL Configuration**.

As policies usam `auth.uid() = user_id` tanto para leitura quanto para inserção/alteração/exclusão. Não desabilite RLS. O navegador recebe apenas a chave pública; o isolamento é aplicado pelo banco.

## Executar localmente

```bash
cp .env.example .env.local
```

Edite `.env.local` com seus valores:

```dotenv
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-anon-ou-publishable
```

Depois:

```bash
pnpm install
pnpm dev
```

Abra o endereço local informado pelo Vite. `.env.local` é ignorado pelo Git. Não coloque segredos no código ou em arquivos versionados.

## Publicar em GitHub Pages

1. Crie o repositório no GitHub e envie estes arquivos para o branch `main`.
2. Em **Settings → Secrets and variables → Actions → New repository secret**, cadastre `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` com os mesmos valores locais.
3. Em **Settings → Pages**, selecione **GitHub Actions** como origem de publicação.
4. O workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) compila e publica a cada push em `main`. O endereço padrão será `https://SEU_USUARIO.github.io/controle-nfse-mei/`.
5. Se o nome do repositório for diferente de `controle-nfse-mei`, ajuste `base` em `vite.config.ts` ou adapte o workflow para passar o caminho correspondente.
6. Cadastre a URL efetiva de produção em Supabase Auth → URL Configuration.

O GitHub Pages não executa servidor próprio: login, persistência e isolamento são fornecidos pelo Supabase.

## Testes e validação

```bash
pnpm test
pnpm build
```

Há testes básicos para leitura de campos do XML, conversão de valores e criação de fingerprint deduplicável. O parser cobre campos comuns de XML NFS-e, mas há variações municipais; confira sempre os dados antes de salvar. PDFs podem ser digitalizações sem texto ou usar layouts variados: nesses casos, o usuário deve preencher os campos manualmente. Os arquivos importados são processados no navegador e não são enviados nem armazenados; o banco guarda os campos estruturados.

## Observações de privacidade e operação

- Cada conta só acessa seus registros conforme políticas RLS do Supabase.
- O arquivo bruto XML/PDF não é armazenado. Salve seu original fora do app se precisar mantê-lo.
- Excluir nota é permanente. O app pede confirmação antes da exclusão.
- A deduplicação é uma proteção prática, não uma validação oficial de autenticidade da nota.
- Configure no Supabase política de retenção, backups, região e controles da conta conforme suas necessidades.
