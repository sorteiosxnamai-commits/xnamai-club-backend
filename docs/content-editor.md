# Conteúdo editorial

O admin oferece **Textos e telas** em `/admin/conteudo`. A conta ADMIN pode editar Início, Planos, Regras, Simulador e Pagamento. Não existe liberação de um usuário novo ou mudança de papel para terceiros nesta entrega.

Cada publicação armazena os textos em `site_content` e registra autor, revisão e conteúdo no `audit_logs`, na mesma transação. A inicialização não sobrescreve esses dados. A API pública retorna somente textos publicados, sem identificadores de autores.

## Uso

1. Escolha a tela e altere os campos.
2. Abra **Prévia da tela** para verificar o rascunho. O rascunho só afeta o iframe da prévia.
3. Use **Publicar alterações**. Novas visitas recebem o conteúdo salvo; abas já abertas atualizam ao recuperar o foco.
4. **Restaurar padrão** prepara um rascunho com os textos originais; exige publicar para entrar no portal.

Conflitos entre administradores retornam HTTP 409 e preservam o rascunho local. É necessário recarregar a versão publicada antes de editar novamente. Campos vazios são rejeitados. O conteúdo é texto simples renderizado por React: tags HTML são exibidas como texto, não executadas.

Preços, destinos de pagamento, antecedências operacionais e cálculos não são controlados pelo editor de texto. O catálogo dos campos editáveis fica no frontend em `src/content/catalog.ts`; os fallbacks são mantidos junto às respectivas telas. Para adicionar campos, atualize ambos. As entradas comerciais de valores nas regras permanecem fixas.

## Banco e implantação

Com `TYPEORM_SYNCHRONIZE=true`, a entidade SiteContent cria a tabela automaticamente, como no ambiente local. Se o ambiente usa `TYPEORM_SYNCHRONIZE=false`, aplicar a criação da tabela antes de implantar a API. Exemplo para PostgreSQL:

```sql
CREATE TABLE IF NOT EXISTS site_content (
  screen varchar PRIMARY KEY,
  "valuesJson" text NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 0,
  "updatedBy" varchar NULL,
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
```

As rotas `/api/admin/content` exigem ADMIN autenticado, consultando o papel e a versão de autenticação atuais no banco. Clientes e atendimento não podem publicar. A API exige o número de revisão lido pelo editor para aceitar uma gravação.

## Asaas

As novas adesões utilizam os quatro links hospedados fornecidos, definidos no frontend em `src/asaas.ts`. Valores por mês: Basic original R$ 299,99, cartão recorrente no lançamento R$ 149,97, PIX R$ 199,99; Fast Pass original R$ 599,99, cartão recorrente no lançamento R$ 297,97, PIX R$ 349,99. O checkout explica a necessidade de selecionar recorrência para a oferta de cartão.

Sem API/webhook do Asaas, não há ativação automática no portal. O cliente é orientado a usar o mesmo cadastro para conferência pelo atendimento. Contratos Stripe existentes não são migrados pelo clique em um link. Após nova solicitação do usuário, CNPJ e nome da empresa passaram a ser obrigatórios no cadastro e na contratação, com validação de formato/DVs e regularização de contas antigas em Dados da empresa; os períodos pagos permanecem acessíveis.
