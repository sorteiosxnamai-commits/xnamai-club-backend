# Cadastro empresarial obrigatório

O cadastro de novos clientes exige nome da empresa e CNPJ com formato e dígitos verificadores válidos. CPF não é aceito em novos cadastros. CNPJs numéricos e alfanuméricos são suportados, com base no manual da Receita Federal/Serpro:

https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/cnpj/manual-dv-cnpj.pdf

Normalização: remover pontuação e espaços, converter letras para maiúsculas e manter as 14 posições. Os primeiros 12 caracteres aceitam A–Z e 0–9; os dois finais são numéricos. O cálculo usa ASCII menos 48, pesos 2–9 e módulo 11. O armazenamento preserva letras; não aplicar filtros de somente dígitos.

## Contas antigas

Login, recuperação de senha, consulta de faturas e acesso ao período já pago permanecem disponíveis. Os endpoints de novo link Asaas, checkout Stripe e upgrade exigem cadastro empresarial regularizado. O servidor responde 403 com `code=BUSINESS_REGISTRATION_REQUIRED` quando faltar CNPJ válido ou nome da empresa.

O cliente acessa **Dados da empresa** em `/app/cadastro-empresa`, informa CNPJ e nome e salva por `PATCH /api/auth/business`. A operação exige usuário CUSTOMER autenticado, confere duplicidade e atualiza document/registration_document_key na mesma transação do registro de auditoria. Não modifica assinaturas, faturas nem períodos pagos. CNPJ válido já cadastrado não pode ser substituído livremente pelo cliente; nesse caso deve procurar atendimento.

## Limites

A validação é de formato e dígitos verificadores. Não consulta a Receita Federal, não verifica situação ativa, CNAE, titularidade ou atividade de lojista. Os termos comerciais continuam estabelecendo exclusividade para lojistas. Os links Asaas abertos diretamente fora do portal permanecem sujeitos à conferência manual.

Nenhuma alteração de esquema adicional é necessária: os documentos já são armazenados em colunas varchar. A chave única de cadastro protege novos registros contra concorrência; contas históricas não são reescritas em lote.
