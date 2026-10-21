# Recuperação de senha de clientes

As rotas públicas `POST /api/auth/forgot-password` e `POST /api/auth/reset-password` atendem somente contas `CUSTOMER`. O pedido de link responde com a mesma mensagem para endereços cadastrados ou não. O envio usa a API transacional HTTPS da Brevo. Em produção, configure `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` e `FRONTEND_URL` somente no backend. `FRONTEND_URL` deve ser a origem HTTPS oficial do frontend, sem caminho, usuário ou senha. Sem configuração, a rota responde 503 para todos os endereços.

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

O servidor aguarda a resposta de `POST /v3/smtp/email` da Brevo antes de responder `202` com a mensagem genérica. A chamada HTTP tem limite de 4 segundos; um piso de 8,5 segundos reduz diferenças de tempo entre contas existentes e inexistentes. `202` significa que o pedido foi processado, não que a mensagem chegou à caixa postal. Quando a Brevo aceita a mensagem, `CUSTOMER_PASSWORD_RESET_EMAIL_ACCEPTED` inclui o `messageId` retornado pela API na auditoria para consultar o estado de entrega na Brevo. Se a API rejeitar a mensagem, a rotina apaga o token emitido, registra `CUSTOMER_PASSWORD_RESET_EMAIL_FAILED` e escreve o status HTTP no log, sem registrar a chave ou o link. Se a resposta do envio se perder, a entrega é incerta: o token fica válido para não invalidar um link possivelmente enviado, e `CUSTOMER_PASSWORD_RESET_EMAIL_UNCONFIRMED` exige verificação operacional. Evite registrar query strings da rota `/redefinir-senha` nos logs de hospedagem, pois o link contém o token até o JavaScript carregar.

O e-mail de recuperação usa somente `textContent`, com a URL visível para abrir ou copiar. Um teste real com a Brevo mostrou que esse formato preserva a URL direta; o botão HTML anterior foi reescrito para o domínio de rastreamento da Brevo e o redirecionamento falhou. E-mails enviados antes dessa alteração continuam com o link antigo e exigem novo pedido de recuperação.

## Ativação manual da Brevo

1. O remetente atual é `sorteiosxnamai@gmail.com`, marcado como ativo na Brevo. Configure `BREVO_SENDER_EMAIL` com esse valor. A Brevo pode substituir o endereço exibido no envio porque `gmail.com` não é um domínio que a conta pode autenticar. Para melhorar a entrega posteriormente, autentique `clubxnamai.com.br` e use um remetente desse domínio.
2. Configure `BREVO_API_KEY` e `BREVO_SENDER_EMAIL` nas variáveis privadas do backend no Render. Configure `FRONTEND_URL` com a origem HTTPS real. Não coloque a chave no frontend, em arquivos versionados ou em logs. Remova as antigas variáveis `GMAIL_SENDER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REFRESH_TOKEN` do serviço; elas não são mais usadas.
3. Depois do deploy, solicite um link para uma conta `CUSTOMER` de teste. Confira o evento `CUSTOMER_PASSWORD_RESET_EMAIL_ACCEPTED` e seu `messageId` na auditoria; na Brevo, acompanhe os logs transacionais desse ID até o evento de entrega. Confirme o recebimento e a validade do link. Nenhum envio real é feito pelos testes locais.

Se a Brevo responder `401` por IP não reconhecido, abra **Segurança → IPs autorizados** na Brevo. Para o backend hospedado no Render, obtenha os intervalos de saída em **Connect → Outbound** no serviço e autorize os intervalos exigidos pela configuração de segurança da conta. O IP do computador de desenvolvimento não é o IP de saída do Render. No plano gratuito do Render, use a API HTTPS: as portas SMTP 25, 465 e 587 são bloqueadas.

Referências: [API de e-mail transacional da Brevo](https://developers.brevo.com/reference/send-transac-email), [autenticação do domínio remetente](https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-DMARC), [segurança de IPs na Brevo](https://developers.brevo.com/docs/ip-security), [IPs de saída do Render](https://render.com/docs/outbound-ip-addresses), [limites do Render gratuito](https://render.com/docs/free).
