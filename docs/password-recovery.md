# Recuperação de senha de clientes

As rotas públicas `POST /api/auth/forgot-password` e `POST /api/auth/reset-password` atendem somente contas `CUSTOMER`. O pedido de link responde com a mesma mensagem para endereços cadastrados ou não. O envio usa a Gmail API via HTTPS, sem SMTP, com a conta `sorteiosxnamai@gmail.com`. Em produção, configure `GMAIL_SENDER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` e `FRONTEND_URL` somente no backend. `FRONTEND_URL` deve ser a origem HTTPS oficial do frontend, sem caminho, usuário ou senha. Sem configuração, a rota responde 503 para todos os endereços.

O servidor persiste apenas SHA-256 do token aleatório de 32 bytes. O hash e o vencimento ficam em colunas nullable de `users`; um pedido novo sobrescreve o anterior. O `UPDATE` de redefinição troca a senha, apaga o hash e incrementa `auth_version` em uma única instrução condicionada a hash, vencimento e papel. Isso impede uso simultâneo ou repetido. JWTs antigos sem `authVersion` são aceitos enquanto a versão da conta for zero; após a primeira redefinição, deixam de ser aceitos. Novos logins recebem a versão atual. A rota administrativa não muda.

Os limites são compartilhados via banco: 20 pedidos/IP/hora e 3 pedidos/e-mail/hora; 30 tentativas/IP/hora e 5 tentativas/hash de token/hora. As chaves armazenadas contêm apenas hashes. Remova periodicamente linhas vencidas de `recovery_rate_limits` com `DELETE FROM recovery_rate_limits WHERE expires_at < <epoch_em_milissegundos>` (por exemplo, em manutenção diária). Falhas do banco bloqueiam a operação; não há fallback para memória.

## Migração manual antes de ativar em produção

Faça backup, aplique o SQL correspondente em uma janela de manutenção e confira colunas e índice. `render.yaml` passa a usar `TYPEORM_SYNCHRONIZE=false`, portanto **o SQL precisa ser aplicado antes de qualquer deploy desse código**. Não execute o sincronizador TypeORM para introduzir estas colunas em produção. Não há migração automática.

PostgreSQL:

```sql
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash varchar(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at timestamp;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token_hash ON users (password_reset_token_hash);
CREATE TABLE IF NOT EXISTS recovery_rate_limits (
  "key" varchar(128) PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at bigint NOT NULL
);
COMMIT;
```

SQLite (em uma base ainda não migrada):

```sql
BEGIN;
ALTER TABLE users ADD COLUMN password_reset_token_hash varchar(64);
ALTER TABLE users ADD COLUMN password_reset_expires_at datetime;
ALTER TABLE users ADD COLUMN auth_version integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token_hash ON users (password_reset_token_hash);
CREATE TABLE IF NOT EXISTS recovery_rate_limits (
  "key" varchar(128) PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at bigint NOT NULL
);
COMMIT;
```

O servidor obtém um access token usando o refresh token OAuth e aguarda a resposta de `users.messages.send` antes de responder `202` com a mensagem genérica. Cada chamada HTTP tem limite de 4 segundos; um piso de 8,5 segundos reduz diferenças de tempo entre contas existentes e inexistentes. `202` significa que o pedido foi processado, não que a mensagem chegou à caixa postal. Se OAuth falhar ou o Gmail rejeitar a mensagem, a rotina apaga o token emitido, registra `CUSTOMER_PASSWORD_RESET_EMAIL_FAILED` na auditoria e escreve erro sanitizado no log. Se a resposta do envio se perder, a entrega é incerta: o token fica válido para não invalidar um link possivelmente enviado, e o evento `CUSTOMER_PASSWORD_RESET_EMAIL_UNCONFIRMED` exige verificação operacional. Evite registrar query strings da rota `/redefinir-senha` nos logs de hospedagem, pois o link contém o token até o JavaScript carregar.

## Ativação manual da Gmail API

1. O proprietário de `sorteiosxnamai@gmail.com` cria ou escolhe um projeto no Google Cloud e ativa a **Gmail API** em APIs e serviços. Em **Google Auth Platform**, configure branding, audiência/usuários de teste e acesso a dados. Solicite **somente** `https://www.googleapis.com/auth/gmail.send`; não peça escopos de leitura ou exclusão. O escopo é sensível e pode exigir verificação da aplicação antes do uso em produção.
2. Crie um cliente OAuth 2.0 com um URI de redirecionamento controlado para a autorização pontual. O proprietário entra na conta remetente, autoriza o escopo `gmail.send` com `access_type=offline` e `prompt=consent`, recebe um authorization code no callback e o troca no endpoint OAuth do Google por um refresh token. Guarde o refresh token em local seguro até configurá-lo no backend; não coloque código, refresh token nem client secret em arquivos versionados, logs ou no frontend. Confira o estado de publicação/consentimento: tokens obtidos no modo **Testing** para usuários externos expiram em sete dias; não dependa desse modo para operação contínua.
3. Armazene `GMAIL_SENDER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REFRESH_TOKEN` nas configurações privadas do backend, e configure `FRONTEND_URL` com a origem HTTPS real. O remetente deve ser exatamente `sorteiosxnamai@gmail.com`, a mesma conta autorizada. A rota ficará indisponível (`503`) enquanto qualquer credencial estiver ausente. Depois da migração de banco e da autorização OAuth, teste a entrega somente para um endereço de teste autorizado e confirme o recebimento e o link. Nenhum envio real foi feito nesta implementação.

Referências: [Gmail API para envio](https://developers.google.com/workspace/gmail/api/guides/sending), [escopos Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes), [OAuth com refresh token](https://developers.google.com/identity/protocols/oauth2/web-server), [limitações do Render Free](https://render.com/docs/free).
