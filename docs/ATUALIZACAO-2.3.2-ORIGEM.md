# Atualização 2.3.2 — Origem da loja, revisão origem-r1

Esta entrega mantém a versão **2.3.2**, com a revisão **origem-r1**, na base verificada da linha 2.3. Os contratos de fila e resultados incertos descritos aqui prevalecem sobre os documentos de versões anteriores. O serviço de licenciamento, a chave pública de verificação, as licenças existentes, o identificador do Windows e o perfil do aplicativo são preservados. Esta revisão não redefine teste gratuito nem prazo de licença.

Campanhas, contatos, grupos reais, ofertas, modelos, mídias, lembretes, usuários, permissões, responsáveis e configurações continuam armazenados. A implementação não acrescenta os módulos excluídos da versão escolhida pelo usuário. Evidências e pendências estão em [Validação da revisão](VALIDACAO-2.3.2-ORIGEM.md); a relação final de testes e hashes acompanha a entrega.

## Instalação e cópia de recuperação

1. Pause as campanhas e lembretes antes da atualização. Encerre o aplicativo pela bandeja: fechar a janela pode somente minimizá-lo.
2. Com o aplicativo encerrado, copie **a pasta inteira** `%APPDATA%\Mega Disparos` para um local privado, identificado com data e versão. Essa cópia inclui banco, mídias e arquivos locais de sessão. Preserve também o instalador anterior.
3. Execute o instalador Windows da **2.3.2, revisão origem-r1**, na pasta dedicada usada anteriormente. A versão numérica continua 2.3.2; confirme a revisão nos arquivos de validação da entrega e a presença da tela **Origem da loja**.
4. Entre com seu usuário existente. Confira licença, campanhas, usuários, responsáveis, BUSCAS, mídias e configurações antes de retomar qualquer envio. Nenhuma campanha diária criada pela captura começa automaticamente.

O aplicativo mantém `%APPDATA%\Mega Disparos` e `br.com.megadisparos.desktop`. Antes de preparar os novos registros operacionais, usa a identificação de atualização `2.3.2-origem-r1` e cria uma cópia consistente e verificada do banco em `backups\antes-atualizacao-2.3.2-origem-r1-….sqlite`. Uma falha na criação/verificação impede a atualização. O snapshot do banco **não copia as mídias nem a sessão separada**; a cópia completa do perfil continua necessária.

O backup portátil pela interface não substitui a cópia integral. Ele transfere apenas os dados declarados no formato exportável e exclui segredos, identidade criptográfica da licença e sessão do WhatsApp. A revisão inclui os metadados exportáveis da origem e referências de mídias; restaurar essa configuração mantém a captura desativada para revisão. Metadados protegidos necessários para baixar uma mídia ainda pendente não são transferidos: pode ser necessário reenviar a publicação ou importar o arquivo.

A identidade protegida da licença continua fora da pasta de campanhas, em `%LOCALAPPDATA%\KennedCodeDisparos-Licensing`, com âncora em `HKCU\Software\KennedCodeDisparos\Licensing`. Não apague, substitua nem copie essa identidade para outro computador. O rollback do perfil do aplicativo não deve substituir o estado da licença. A validação online pode ser necessária ao reabrir; restaurar uma campanha antiga não renova a licença nem libera outro teste.

### Bancos com esquema 8

A revisão reconhece o esquema 8 conhecido quando sua estrutura comum é equivalente, inclusive diferenças cosméticas do SQL e colunas acrescentadas pela migração histórica. Mantém o cabeçalho 8 e os registros/tabelas adicionais existentes, sem ativar os módulos excluídos. A primeira abertura compatível cria backup e mantém as automações pausadas para revisão. Campanhas com referências a recursos de outra linha podem exigir revisão explícita antes de usar seu conteúdo nesta versão.

Um número de esquema conhecido não autoriza abrir qualquer estrutura: falta de coluna, índice de unicidade ou restrição necessária continua sendo motivo de bloqueio. Não reduza manualmente `PRAGMA user_version`, não apague o banco e não redefina o perfil para contornar a verificação. O banco particular fornecido no Drive, com aproximadamente 620 MB, não pôde ser baixado pelo conector nesta execução; a compatibilidade desse arquivo específico não foi confirmada.

## Configurar a Origem da loja

1. Conecte o WhatsApp e sincronize os grupos. No modo real, selecione um grupo **existente obtido da conta**, como `Guilherme Kenned - Mega Celulares`. O sistema salva o ID real do WhatsApp; mudar o nome do grupo não troca a origem.
2. Abra **Origem da loja → Grupo de origem e participantes**. Escolha o grupo e autorize os participantes por número completo com país/DDD ou identificador confiável resolvido pela integração. Nome de exibição não concede acesso.
3. Habilite **suas mensagens manuais da conta conectada** se quiser publicar pelo número da loja. A identidade própria precisa ser comprovada pela sessão; mensagens automáticas do aplicativo são excluídas da captura.
4. Salve e ative a captura. Só novas publicações a partir desse momento entram automaticamente. Configure um período anterior somente pela ação de importação explícita, quando houver suporte real da integração. O histórico não é considerado completo.

Configurar a origem exige as permissões de configurações, grupos, criação de campanhas e mídias validadas no backend. A licença e a parada geral também são verificadas. BUSCAS continua independente: os grupos de origem, grupos monitorados para ofertas e locais autorizados para comandos não são a mesma configuração.

### Foto e legenda

Publique a **foto com a legenda na mesma mensagem**. A captura preserva os bytes disponíveis da foto, texto completo, quebras, emojis, caracteres especiais, preço, observações e assinatura. Ela não corrige preços nem troca assinaturas. A mídia é copiada para a biblioteca gerenciada antes de o item ficar pronto.

Foto sem legenda e texto separado aparecem para revisão. Não existe associação automática apenas pela proximidade do horário. Publicações em álbum conservam os vínculos explícitos oferecidos pelo protocolo; também há agrupamento manual das fotos escolhidas. Isso preserva referências e conteúdo, sem prometer envio de um álbum WhatsApp idêntico ao original quando a integração não oferecer esse formato.

Se o download falhar ou ultrapassar o prazo, o item fica pendente ou com erro para tentar novamente, importar ou revisar. Os demais itens continuam. Metadados necessários para recuperação do download só são persistidos com proteção do sistema operacional; se essa proteção não estiver disponível, a interface informa que pode ser necessário reenviar a publicação. Legendas são dados: `!mega` ou `!busca` dentro delas não executam comandos.

## Configurar e iniciar a campanha diária

A primeira publicação válida de foto com legenda cria o rascunho **Lista da loja — DD/MM/AAAA**. O rascunho já aparece enquanto a mídia está pendente; o item só fica pronto após o arquivo ser salvo. As próximas publicações da mesma origem e data entram na mesma campanha. A data usa o instante original da mensagem em **America/Sao_Paulo**; a próxima data cria outro rascunho na primeira publicação válida.

Abra o rascunho e configure destinos, ordem, horários, dias, rodadas e encerramento. Se houver um modelo de configurações salvo na origem, aplique-o e revise. O modelo não autoriza o primeiro disparo: confirme a prévia antes de iniciar. O grupo de origem não pode ser destino dessa automação, evitando ciclos de captura.

| Configuração | Significado |
|---|---|
| Entre mensagens, em segundos | Espera entre itens para o mesmo destino. |
| Entre grupos, em segundos | Espera ao mudar para o próximo destino. |
| Entre inícios de rodadas, em minutos | Frequência da rodada completa; padrão 10 minutos. |
| Máximo de rodadas | Limite total configurado; zero significa sem limite adicional. |
| Encerramento | Impede novos envios a partir do instante indicado. |
| Dias, janela e limites diários | Restringem a execução mesmo quando o intervalo permitir outra rodada. |
| Tempo limite por tentativa | Padrão global 30 segundos, configurável entre 5 e 300; pode haver valor específico da campanha. |

Os intervalos respeitam o mínimo da integração, sem mecanismos para contornar limites. Uma rodada termina quando os itens previstos para seus destinos tiveram um resultado operacional registrado: aceito, entregue, incerto, falha ou cancelamento. Rodada concluída não significa que todos os destinatários receberam todas as mensagens.

A rodada congela seus itens e conteúdos ao começar. Um novo item ou edição entra na próxima rodada; o conteúdo já enviado permanece no registro. Exclusão recebida pela integração, ou remoção manual, retira itens dos envios ainda não iniciados. Mensagens já submetidas podem concluir e não são apagadas nos grupos de destino. O aplicativo nunca promete recuperar todas as rodadas perdidas nem executar duas simultaneamente.

## Resultados, grupos e alertas

| Estado | Evidência e ação |
|---|---|
| Aguardando | Registro persistente ainda não submetido. |
| Enviando | Tentativa em processamento; não significa sucesso. |
| Envio aceito pela integração | Confirmação de aceitação disponível; ainda não comprova recebimento no celular. Registros antigos `confirmed` mantêm essa interpretação. |
| Entrega confirmada | Exige recibo de entrega correspondente, quando disponível. |
| Resultado incerto | O envio pode ter ocorrido. Fica separado para revisão e não é reenviado automaticamente. |
| Falha confirmada | Falha comprovada, com código e motivo. Só falha temporária segura admite tentativa limitada. |
| Cancelado | Trabalho cancelado antes de nova submissão; não recolhe uma mensagem já enviada. |

O prazo de uma tentativa impede que uma promessa de transporte sem resposta ocupe a fila indefinidamente. Ao vencer, as próximas tarefas elegíveis continuam respeitando os intervalos. A mesma combinação incerta de campanha/item/destino fica protegida contra repetição até revisão, mas não paralisa os demais itens e grupos. Respostas e recibos tardios atualizam a operação correspondente sem criar outra submissão.

Use **Verificar incertos** para consultar evidências disponíveis da mensagem. Essa verificação não envia novamente. Se não houver prova confiável, uma repetição manual exige aviso/aceite de possível duplicação e gera tarefa vinculada ao registro original. Falhas comprovadas e recuperáveis usam limite e intervalo progressivo; falta de resposta não é prova de falha.

No acompanhamento da campanha, confira itens prontos/pendentes, origem, destinos aptos/indisponíveis, rodada/próxima execução, contagens por resultado e último erro de cada grupo. **Verificar novamente** atualiza a condição do destino; reativar um grupo não inicia automaticamente uma campanha pausada.

O sistema distingue, quando houver metadados confiáveis, ausência de participação, grupo restrito a administradores, conta sem permissão, ID inválido, falha temporária e perda geral de conexão. Metadados incompletos não comprovam remoção. O motivo desconhecido permanece identificado como desconhecido, com detalhe técnico sanitizado. Uma falha isolada suspende o destino quando necessário e permite continuar os demais; queda geral pausa os envios até a recuperação.

Os alertas usam os responsáveis/donos/destinatários ativos já cadastrados. Confira os números com país e DDD e use **Enviar alerta de teste**. O aviso identifica campanha, grupo, ID, item, horário original e motivo; não afirma que os demais continuam quando a conexão geral estiver indisponível. A primeira ocorrência é avisada e recorrências do mesmo problema são agrupadas. Em Configurações, o intervalo dos resumos começa em **900 segundos**, ajustável de **60 a 86.400 segundos**. Falha ao enviar o próprio alerta não gera outra cadeia de alertas.

Na desconexão, a ocorrência aparece localmente e solicita notificação/som conforme as configurações. O aviso privado fica pendente para reconexão, com horário original. Entrada na fila não é envio aceito nem entrega. Notificações físicas e som dependem de aplicativo em execução, permissões, mixer/mudo do Windows e horário silencioso.

**PARAR TODOS OS ENVIOS** ou `!mega parar tudo` cancela pendências automáticas e bloqueia novas entradas, incluindo captura e automações, até retomada explícita. Preserva cadastros e deixa comandos administrativos disponíveis. Informe-se sobre os envios já em andamento: eles podem não ser canceláveis. Ao retomar o sistema, revise e inicie individualmente as campanhas desejadas.

## Recuperar a versão anterior

1. Encerre completamente a revisão atual e guarde outra cópia privada integral do perfil, preservando registros posteriores ao backup.
2. Reinstale o aplicativo anterior compatível com **o banco anterior correspondente**, sem executá-lo ainda. Restaure a cópia completa do perfil feita antes da atualização, mantendo a cópia atual separada. Não misture banco, WAL, mídias e sessões de momentos diferentes.
3. Preserve a identidade atual da licença em `%LOCALAPPDATA%` e no registro do Windows. A licença é validada pelo mesmo serviço; não restaure uma identidade de outro dispositivo ou um comprovante antigo para alterar validade.
4. Abra com os envios pausados, valide a licença online quando necessário e revise mensagens confirmadas depois do instante do backup antes de retomar. Um backup antigo pode desconhecer essas confirmações e permitir duplicações se for usado sem revisão.

Se houver somente snapshot SQLite, ele precisa ser restaurado como `mega.sqlite` com o aplicativo encerrado e os antigos arquivos `mega.sqlite-wal`/`mega.sqlite-shm` retirados do perfil ativo, mantendo cópia deles. Isso não recupera arquivos de mídia ou sessão ausentes. Uma versão anterior que recusava o esquema 8 continuará recusando esse mesmo banco: reinstalar o executável sozinho não é recuperação compatível. Não use reset ou redução manual do esquema como rollback.

## Limitações e teste no ambiente real

A integração Baileys é **não oficial**. Eventos de edição/exclusão, identificação PN/LID, álbuns, histórico, acessibilidade dos grupos e recibos dependem do protocolo e da sessão conectada. Uma pré-verificação não substitui o erro no envio, pois permissões podem mudar.

O aplicativo e o computador precisam permanecer ligados, conectados e sem suspensão para capturar e enviar. Nenhum teste desta revisão estabeleceu recebimento real no particular, captura de uma conta real ou instalação física no Windows do usuário. Use somente contas, números e grupos de teste autorizados e acompanhe Diagnóstico; o [roteiro de validação](VALIDACAO-2.3.2-ORIGEM.md) diferencia cada evidência.
