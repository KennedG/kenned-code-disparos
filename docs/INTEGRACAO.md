# Integração verificada em 01/10/2026

## API oficial da Meta

A [Groups API da Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) existe e suporta texto, mídia e templates. A documentação consultada exige **Official Business Account (OBA)**, permite **8 participantes por grupo**, até 10.000 grupos criados por número empresarial e uma empresa Cloud API por grupo. Números do aplicativo WhatsApp Business e números em Multi-solution Conversations não são elegíveis. Grupos são criados programaticamente, com adesão por convite; a API não oferece a conexão pelo QR de uma conta comum para listar e utilizar livremente seus grupos anteriores.

A elegibilidade atual diz “all businesses with an OBA”; esta entrega **não repete o antigo requisito de 100.000 conversas** como regra atual. Não existe aqui promessa de que a API oficial possa acessar arbitrariamente seus 15 grupos existentes.

Alternativa oficial: se sua empresa for elegível, criar novos grupos da Groups API dentro do limite de 8 participantes e implementar um adaptador Cloud API com suas credenciais e infraestrutura de webhooks. Não foi substituído silenciosamente o cenário de grupos existentes por essa alternativa.

## Integração implementada

**Baileys, 7.0.0-rc14**, uma biblioteca comunitária **não oficial** do protocolo de aparelhos conectados do WhatsApp. Não é produto, API autorizada nem integração certificada da Meta. Fontes: [repositório e aviso do projeto](https://github.com/WhiskeySockets/Baileys), [documentação](https://baileys.wiki/), [API de grupos](https://baileys.wiki/docs/socket/group-management), [envio de mensagens](https://baileys.wiki/docs/socket/messages/send), [pacote fixado](https://www.npmjs.com/package/@whiskeysockets/baileys/v/7.0.0-rc14).

O código da versão fixada oferece `groupFetchAllParticipating` e `sendMessage` com texto, imagem, vídeo e documento. O aplicativo usa essas operações, com arquivos gerenciados e legendas. Conecta por QR Code no fluxo Aparelhos conectados. Não adiciona participantes nem procura novos grupos; usa grupos nos quais a conta conectada já participa e nos quais você declara ter autorização para publicar.

Limitações: alterações de protocolo, desconexões, limitações por conta, remoção do grupo, permissão exclusiva de administradores, arquivos incompatíveis e restrições de uso podem impedir os envios. **Não existe um intervalo universal garantido como seguro nem entrega garantida a todos os integrantes.** Dez minutos e 15 grupos são configurações do agendador, não autorização ou garantia dada pelo WhatsApp. O projeto Baileys informa não incentivar mensagens em massa/automação indevida; a responsabilidade pelas permissões e condições da conta continua com seu titular.

O remetente dos comandos é extraído dos metadados autenticados da conexão. Identificadores LID só são aceitos quando também existe um número real verificado no protocolo. Caso o número não possa ser resolvido com segurança, o comando é ignorado. Outro número administrador deve falar em conversa privada com a conta conectada; mensagens `fromMe`, encaminhadas ou em grupo não executam comandos.

Confirmação de envio usa ACK do servidor e recibos do protocolo. `sendMessage` retornar não é, sozinho, confirmação. Ausência de ACK em 20 segundos ou erro após tentativa de submissão produz resultado incerto e pausa para revisão. Após reinício, o aplicativo não consulta um histórico remoto confiável de todos os envios; mantém resultados incertos e exige verificação manual se não houver confirmação posterior. Isso atende à alternativa solicitada de revisar em vez de reenviar automaticamente.

Nenhuma conta foi conectada nesta entrega e nenhum envio real foi realizado. Os testes de transporte usam eventos e mensagens simulados, não comprovam a operação contra uma conta real nem instalação em um Windows físico.
