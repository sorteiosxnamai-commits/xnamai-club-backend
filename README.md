# XNaMai Club — Backend Node.js

API REST em Node.js + TypeScript + Express + TypeORM, com JWT, RBAC e criação automática do schema em desenvolvimento.

## Recursos

- Cadastro e login com JWT.
- Roles `CUSTOMER` e `ADMIN`.
- Planos persistidos no banco.
- Assinatura com cartão tokenizado ou PIX recorrente (provedor de pagamento demonstrativo).
- Área do cliente: assinatura, método e cobranças.
- Admin: KPIs, assinaturas, clientes e pagamentos.
- TypeORM no estilo Hibernate/JPA com entidades/decorators.
- SQLite por padrão: o arquivo e todas as tabelas são criados automaticamente.
- Compatível com PostgreSQL via `.env`.

## Rodar

```bash
cp .env.example .env
npm install
npm run dev
```

API: `http://localhost:4000/api`

### Admin demo

- E-mail: `admin@xnamai.local`
- Senha: `Admin123!`

Altere essas credenciais no `.env` antes de qualquer ambiente compartilhado.

## Banco automático

Com `DB_TYPE=sqlite` e `TYPEORM_SYNCHRONIZE=true`, o TypeORM cria o arquivo `data/xnamai.sqlite` e as tabelas automaticamente.

Para PostgreSQL, crie apenas o database vazio e configure `DB_*`; o TypeORM cria as tabelas. **Em produção, prefira migrations e `TYPEORM_SYNCHRONIZE=false`.**

## Pagamentos

O projeto NÃO armazena número completo do cartão nem CVV. O endpoint de assinatura recebe um `paymentToken`, que representa o token retornado por um SDK/Hosted Fields do gateway real.

Endpoint principal:

```http
POST /api/subscriptions
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "planId": "uuid",
  "paymentMethodType": "CREDIT_CARD",
  "paymentToken": "pm_demo_123",
  "cardBrand": "Visa",
  "cardLastFour": "4242"
}
```

Ao escolher o gateway real, substitua a camada demo e implemente validação criptográfica de webhook.

## Rotas

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/plans`
- `POST /api/subscriptions`
- `GET /api/subscriptions/me`
- `POST /api/subscriptions/:id/cancel`
- `GET /api/me/dashboard`
- `GET /api/admin/dashboard`
- `GET /api/admin/subscriptions`
- `GET /api/admin/customers`
- `GET /api/admin/payments`
- `POST /api/webhooks/payment-provider`
"# xnamai-club-backend" 
