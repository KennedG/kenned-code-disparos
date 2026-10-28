# Kenned Code Disparos 2.3.2 — Interface R9

Base: R8. Atualização restrita à interface; o backend, os comandos e o transporte WhatsApp permanecem idênticos à R8 que o usuário confirmou receber respostas.

Causa reproduzida: atualizações de estado reconstruíam o conteúdo da página, removendo o estado aberto dos elementos details. A correção mantém esse estado por identificador ou título da seção, conserva a rolagem interna e evita substituir formulários enquanto recebem foco. Recolher a lateral ou abrir Mais ferramentas deixa de forçar a reconstrução dos formulários.

Atualização: faça backup em Configurações, feche o aplicativo inclusive na bandeja e instale o setup R9 sem apagar os dados. Confira 2.3.2 · R9. Não há migração do banco, mudança de licença, redefinição de destinatários ou alteração de campanhas. A R8 permanece em Antigos para recuperação.

Teste: abrir Comandos no particular e Configurações de Oportunidades; receber atualizações; manter aberto, editar campos e conferir os valores. As proteções de licença e de perda de permissão continuam podendo interromper o acesso deliberadamente.

Os testes controlados não comprovam envios reais. O usuário confirmou uma resposta WhatsApp na R8; não se presume que alertas e todas as oportunidades tenham sido confirmados no celular. Nenhum envio real foi feito no ambiente de desenvolvimento.
