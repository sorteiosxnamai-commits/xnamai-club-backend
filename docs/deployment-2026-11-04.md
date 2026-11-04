# Implantação das correções de 04/11/2026

## Estado

Código preparado e validado localmente. O backend está no mesmo commit de origin/main, com as alterações desta entrega ainda locais. Os dois commits remotos anteriores foram incorporados preservando o editor e a remoção dos logs.

A conexão Vercel disponível nesta sessão lista somente a equipe jpedro00s-projects e não lista o projeto xnamai-club-frontend. Não foi encontrado acesso ao serviço Render nesta sessão. Nenhuma publicação ou migração no banco de produção foi realizada.

## Ordem de implantação

1. Confirmar projeto Vercel do frontend, serviço Render da API e banco PostgreSQL correspondentes ao Club. Guardar um backup do banco e os identificadores das versões atuais.
2. No backend, executar `npm ci` e `npm run build`. Com o ambiente apontando explicitamente para o banco de produção, executar `npm run migrate`. O comando força synchronize=false e aplica a migração aditiva: site_content, priority_reservations e subscriptions.billingAmountCents. Não altera preços nem senhas de contratos existentes.
3. Publicar a API com TYPEORM_SYNCHRONIZE=false. A inicialização passa a escutar somente depois de inicializar banco e seed. Contas privilegiadas existentes não têm e-mail, papel ou senha sobrescritos. Para criar a primeira conta em um banco novo de produção, definir ADMIN_EMAIL/ADMIN_PASSWORD e SUPPORT_EMAIL/SUPPORT_PASSWORD (senhas com pelo menos 12 caracteres).
4. Conferir `/api/health`, `/api/plans` e a rejeição HTTP 401 em `/api/atendimento/members` sem token. ADMIN/SUPPORT devem acessar; CUSTOMER deve receber 403. A listagem de planos informa PIX por plano e disponibilidade do Fast Pass.
5. Publicar o frontend com VITE_API_URL apontando para a origem correta da API. Conferir CORS/FRONTEND_URL antes de mudar os domínios. Verificar login, editor, atendimento, valores dos dois planos e os quatro destinos Asaas sem realizar pagamentos reais de teste.

## Operação com links Asaas

O usuário escolheu somente os quatro links fornecidos, sem API/webhook do Asaas. O endpoint local `/api/subscriptions/payment-link` valida usuário, plano e capacidade antes de devolver o destino. O pagamento ocorre no Asaas e a liberação no portal depende da conferência manual.

O Fast Pass reserva uma vaga por 32 minutos por tentativa. A contagem usa clientes com acesso efetivo e reservas válidas, sem duplicar o mesmo cliente. O bloqueio transacional serializa a última vaga no PostgreSQL; SQLite serializa transações na aplicação. Sessões Stripe têm expiração de 31 minutos e a ativação revalida capacidade para pagamentos atrasados. Cada tentativa possui ID próprio; a falha de uma tentativa não libera a reserva de outra.

Links Asaas compartilhados ou abertos diretamente fora do fluxo do portal podem receber pagamentos sem reserva. Antes de liberar acesso, o atendimento deve conferir pagamento e disponibilidade. Se houver pagamento após expiração da reserva sem vaga disponível, regularizar com o cliente, inclusive reembolso quando aplicável. O código não executa reembolsos automáticos nem migra assinaturas Stripe para Asaas.

## Previsões

PIX avulso e cancelamentos agendados não entram como receita futura automática. O valor recorrente é capturado do item da assinatura Stripe e persistido em billingAmountCents. Os contratos legados são preenchidos durante a sincronização administrativa. Sem valor recorrente verificado, o contrato fica fora da previsão e a tela informa quantos aguardam conferência. Totais de faturas proporcionais não são usados como mensalidade.

## Retorno à versão anterior

Manter as novas tabelas/coluna aditivas no rollback de aplicação, preservando conteúdo editorial, histórico e valores contratados. Não usar synchronize=true em produção para reverter esquema. Após rollback, conferir atendimento: a versão antiga tinha endpoints públicos e não deve ser restaurada sem manter a proteção de autenticação.
