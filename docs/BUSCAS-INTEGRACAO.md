# BUSCAS e a integração do WhatsApp

O aplicativo utiliza **Baileys 7.0.0-rc14, uma integração não oficial** baseada no protocolo do WhatsApp Web. A sessão continua protegida pelo Windows, e os envios continuam sujeitos às restrições do WhatsApp. Não há mecanismos para contornar limites, entrar automaticamente em grupos ou consultar contas externas.

## O que o adaptador implementa

- Captura por eventos das mensagens recebidas: texto e legendas de imagens, vídeos e documentos. Não há consultas periódicas para procurar anúncios, nem downloads automáticos de mídias dos fornecedores.
- Preservação do identificador da mensagem, conversa, remetente autenticado, texto original, encaminhamento quando informado, data original e momento da captura. Os nomes não são usados para autorizar pessoas.
- Eventos separados para edição e exclusão. Uma edição mantém a referência da mensagem e informa a data da revisão; a data da revisão não substitui a data original da oferta.
- Grupos participantes retornados pela conta, incluindo os campos `linkedParent`, `isCommunity` e `isCommunityAnnounce` **somente quando fornecidos pela integração**. Os grupos monitorados e os grupos que recebem comandos são seleções independentes.
- Envio dos resultados para um destinatário explícito. A submissão utiliza um identificador durável e aguarda ACK autenticado ou recibo. Resultado sem confirmação é `incerto` e não é reenviado automaticamente.
- Importação oportunista de eventos reais de histórico, quando habilitada. Os lotes são processados em partes de até 100 mensagens e têm uma fila limitada; qualquer truncamento produz um aviso de lacuna.

O serviço BUSCAS valida as pessoas e conversas autorizadas antes de executar comandos. Ele valida também o destino da resposta: grupos recebem resultados somente quando a opção de responder na origem está explicitamente habilitada. Os comandos antigos `!mega` mantêm suas regras anteriores. Textos de fornecedores, mensagens encaminhadas e históricos não alteram configurações ou permissões.

## Limitações reais

**Grupos e comunidades.** A conta precisa participar do grupo e receber suas mensagens. A integração não garante acesso a todos os grupos de uma comunidade, a mensagens ocultas, a mensagens anteriores à entrada, nem a grupos dos quais a conta foi removida. Os metadados da comunidade podem estar ausentes. Um grupo de avisos pode ter restrições próprias de publicação.

**Histórico.** O aplicativo mantém `syncFullHistory: false`. Ao habilitar a importação, ele aceita `messaging-history.set` e mensagens `append` disponibilizadas pelo aparelho/serviço. Há uma operação de protocolo `fetchMessageHistory` que depende de uma mensagem âncora e do aparelho vinculado; ela não é uma consulta universal aos arquivos de um grupo e não é utilizada para prometer ou obter histórico completo. Uma etapa com `progress: 100`, `isLatest` ou status `complete` não prova que toda a história dos grupos foi capturada. Messages atrasadas após reconexão preservam a data original e entram como dados, nunca como comandos. Períodos desconectados, aplicativo encerrado, exclusões não recebidas e limites da fila podem deixar lacunas.

**Identificação.** Para mensagens recebidas, o remetente vem de `key.participant` em grupos e de `key.remoteJid` em conversas privadas. Para mensagens enviadas manualmente pela própria conta (`fromMe`), o autor vem da identidade autenticada da sessão; `remoteJid` identifica o destino, não o autor. A opção BUSCAS de comandos próprios exige vínculo dessa identidade com um dono ativo e um local habilitado. Respostas automáticas são reconhecidas por identificadores persistentes antes da submissão, evitando loops mesmo após reinício. Identificadores `@lid` são identificadores internos, não telefones. Um número aparece somente quando há um JID telefônico real ou um número alternativo/mapeamento confiável informado pelo protocolo. Se o número não estiver disponível ou houver uma divergência, ele fica vazio e a interface apresenta “Número indisponível”. O nome salvo vem de `Contact.name`, quando recebido; o nome exibido vem de `pushName`/`Contact.notify`. Mensagens encaminhadas não comprovam a identidade do fornecedor original.

**Edições e exclusões.** O aplicativo trata os eventos que receber enquanto estiver executando. Não presume que uma exclusão ou alteração ocorrida durante uma lacuna será informada depois. Uma operação de exclusão de toda a conversa é tratada como invalidação das referências capturadas daquela conversa; não apaga campanhas ou mídias.

**Links.** É possível gerar `https://wa.me/NUMERO` somente para um telefone real válido. A integração não oferece um link universal válido para uma mensagem arbitrária de grupo; o módulo não inventa links de mensagens. Um telefone escrito no anúncio é um contato informado, separado do número autenticado do remetente.

**Resolução do destinatário.** O número cadastrado é consultado pelo mecanismo `onWhatsApp` e mapeamentos PN/LID confiáveis quando necessários. A própria conta usa sua identidade autenticada. Ausência de API, número não encontrado, timeout ou número retornado divergente produzem erro explícito; o aplicativo não troca o destino pela origem. Se um número brasileiro tiver cadastro canônico diferente (por exemplo, sem nono dígito), revise o telefone após o código `WA_RECIPIENT_MISMATCH`; o aplicativo não faz essa mudança automaticamente.

**Confirmação.** ACK confirma a aceitação pelo WhatsApp, sem comprovar que o destinatário leu a mensagem. A resolução de `sendMessage()` sozinha não é apresentada como envio confirmado. Desconexões interrompem a captura e os envios; nenhuma resposta incerta é repetida automaticamente.

## Fontes verificadas e validação

A implementação foi conferida com os tipos e o código-fonte da dependência instalada e com os arquivos públicos do mesmo release:

- [Eventos do Baileys 7.0.0-rc14](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Types/Events.ts): `messages.upsert`, `messages.update`, `messages.delete`, `messaging-history.set`, `messaging-history.status`, contatos e mapeamentos LID/PN.
- [Metadados de grupos](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Types/GroupMetadata.ts).
- [Recepção e histórico sob demanda](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Socket/messages-recv.ts).
- [Processamento de edição e revogação](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/src/Utils/process-message.ts).
- [Projeto Baileys](https://github.com/WhiskeySockets/Baileys), que se descreve como biblioteca para o protocolo do WhatsApp Web, sem integração oficial da Meta.

`test/search-adapter.test.cjs` verifica seleção independente de grupos/comandos, captura de listas e legendas, nomes, telefone indisponível, resolução real de LID/PN, deduplicação, histórico parcial, mensagens atrasadas, edição, revogação, exclusão, metadados de comunidade, destinatário da resposta, ACK, resultado incerto e desconexão. Os testes utilizam transporte injetado e simulação identificada. Nenhuma conta real, grupo real ou envio real foi usado na validação automatizada.
