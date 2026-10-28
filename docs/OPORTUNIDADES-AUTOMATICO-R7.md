# Oportunidades — revisão Automático R7 / versão 2.3.2

Atualização restrita a OPORTUNIDADES, sobre a versão vigente Estabilidade-R5. Não inclui a revisão experimental Continuidade-R6. O identificador do aplicativo, o perfil de dados e as configurações de licenciamento permanecem iguais. Sem módulos financeiros, estoque comercial ou inteligência artificial.

## Configurar

1. Feche o aplicativo e execute o instalador desta revisão. Não exclua a pasta de dados. Na primeira abertura desta revisão, o aplicativo gera e verifica uma cópia SQLite em `backups/pre-oportunidades-r7-*.sqlite` no perfil local, antes dos novos índices e da alteração da política de oportunidades.
2. Em Usuários, vincule o WhatsApp particular a um único administrador ativo, com país e DDD. Esse usuário precisa das permissões de gerenciar/responder oportunidades e controlar automações. Um número compartilhado por dois usuários será recusado.
3. Em Oportunidades, cadastre esse número em **WhatsApp particular do administrador**. Escolha os grupos monitorados e as campanhas que fornecem os anúncios. Configure os grupos de destino nessas campanhas e autorize-os no cadastro de Grupos.
4. O modo automático fica ligado por padrão na primeira atualização desta política. A captura só funciona quando habilitada e configurada; a licença e a parada geral continuam sendo respeitadas. Uma escolha posterior de modo manual é preservada após reiniciar.
5. Uma procura clara e compatível seleciona um anúncio da campanha por regras fixas. Não há consulta ao estoque, prazo de confirmação de estoque ou modelo de linguagem. A seleção manual também permite anúncios sem preço interpretado.
6. Para escolher diretamente: **Escolher celular da campanha → Selecionar e enviar**. Esse clique autoriza o envio, sem outra confirmação. No modo manual, oportunidades identificadas automaticamente aguardam `!aprovar ID` ou `!recusar ID`.

## Destinos e conteúdo

O anúncio vai somente para os grupos que constam como destinos da campanha escolhida. O interessado que fez o pedido não é acrescentado como destinatário. Não existe disparo a todos os contatos. O texto, a legenda e a mídia originais são preservados; a mensagem particular ao administrador contém ID, cliente, celular selecionado e mensagem da campanha. Outro aviso informa o resultado de cada oportunidade.

Anúncios removidos, arquivos inexistentes, destinos retirados, contato silenciado, pedido encerrado/expirado, licença bloqueada e parada geral continuam impedindo novos envios. Isso é controle operacional, não consulta ao estoque. No automático, modelo e filtros explícitos precisam corresponder; casos ambíguos ficam para seleção manual. Os limites de repetição continuam persistidos.

## Comandos no particular

Envie do administrador configurado para o número conectado:

- `!automatico on`: ativa o modo automático. Se houve parada geral, é uma retomada explícita das novas automações; não reinicia campanhas antigas nem recria tarefas canceladas.
- `!automatico off`: novos pedidos geram aviso particular e aguardam sua decisão. Envios automáticos ainda não iniciados aguardam aprovação.
- `!aprovar ID`: aprova e coloca o anúncio selecionado na fila dos destinos da campanha.
- `!recusar ID`: encerra a oportunidade e cancela seus envios ainda não iniciados.
- `!pausar`: usa a parada geral existente, cancela pendências e bloqueia novas automações. Um envio já submetido pode concluir; seu resultado é registrado.
- `!status`: informa modo, parada e pendências.
- `!ajuda`: lista os comandos.

Só o número configurado, vinculado de forma inequívoca ao administrador ativo e autorizado, executa esses comandos. Mensagens de grupos, encaminhadas, antigas ou geradas automaticamente não executam instruções. Não se autoriza pelo nome de perfil.

## Resultados e recuperação

A fila e os avisos são persistentes e separados da antiga fila privada ao interessado. A atualização cancela tarefas antigas ainda não iniciadas dessa fila; preserva registros de mensagens aceitas, entregues ou incertas. Reiniciar ou reconectar não autoriza uma nova cópia da mesma tarefa. Falhas comprovadamente temporárias têm tentativas limitadas. Resultado incerto libera outros envios elegíveis e exige verificação, sem repetição automática.

Aguardando/processando não é enviado. Aceito pela integração não significa entregue no celular. Entrega só aparece com comprovante disponível. Os detalhes da oportunidade mostram os resultados por destino e os avisos ao administrador.

## Recuperar a revisão anterior

Mantenha a pasta de dados e as mídias intactas. Feche todas as instâncias. Faça uma cópia integral do perfil antes de qualquer recuperação. O instalador anterior permanece em `Antigos` no Drive. Se for necessário restaurar o banco anterior, use a cópia local `pre-oportunidades-r7-*.sqlite`, com o aplicativo fechado, preservando à parte o banco atual e seus arquivos auxiliares. Uma cópia anterior pode não conter envios posteriores: mantenha a parada geral ativa e confira os registros antes de reativar qualquer campanha. Não substitua um banco aberto nem apague registros incertos para forçar reenvio.

## Limitações verificáveis

Baileys é uma integração não oficial do WhatsApp. O aplicativo e o computador precisam estar em execução, conectados e com licença válida. A captura depende dos eventos e das identidades que a sessão fornece. Não se criam telefones a partir de LIDs. A ausência de um telefone seguro impede comandos particulares e avisos que precisem desse número.

Não havia sessão real de WhatsApp conectada no ambiente de desenvolvimento. Testes automatizados e do aplicativo empacotado usam transporte simulado/controlado e não comprovam recebimento em um celular real. A instalação física no Windows e o recebimento dos avisos no particular devem ser validados na máquina e sessão do usuário. O código antigo da academia não foi localizado; nenhum dado, telefone, credencial ou integração daquele sistema foi copiado.
