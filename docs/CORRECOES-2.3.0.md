# Kenned Code Disparos 2.3.0 — alterações e limites de validação

A versão atualiza o aplicativo existente sem mudar o perfil `%APPDATA%\Mega Disparos`, appId do Windows, credenciais ou identificadores das campanhas. O SQLite passa ao esquema 7 com cópia anterior à migração. Referências legítimas a Mega Celulares e conteúdo de campanhas não são renomeados.

## Causas corrigidas

- **Busca privada:** a entrega seguia o destinatário geral, em vez de responder exclusivamente ao solicitante, e exigia uma consulta `onWhatsApp`/USYNC mesmo para uma conversa recebida e autenticada. Essa consulta podia falhar ou retornar um telefone canônico diferente. A resposta agora usa o chat real e uma prova emitida pelo adaptador, ligada à conta/remetente/conversa. Números desconhecidos continuam com validação estrita; não há fallback para outro destino.
- **Identidade e reconexão:** eventos LID podiam chegar ao controle antes da resolução confiável do telefone, e o cache de destinatários se perdia na reconexão. O adaptador resolve a identidade antes do comando e conserva hints comprovados na sessão cifrada, com prazo e vínculo à mesma conta. Não transforma LID em telefone fictício.
- **Comandos administrativos:** a auditoria usava horário ISO em um contrato SQLite numérico, causando erro durante o fluxo de comando. O registro agora usa milissegundos e foi exercitado com banco real.
- **Modelos:** a criação dependia de `window.prompt`, não suportado pelo Electron, e a gravação não oferecia edição mantendo o identificador. Há editor próprio e serviço autorizado de criar/editar/duplicar/excluir/aplicar, com verificação da persistência antes de confirmar.
- **Contatos:** uma listagem em cache podia permanecer desatualizada depois de salvar a pendência. O fluxo atualiza a listagem e invalida o cache, preservando os dados gravados.
- **Fila de buscas:** cancelamentos durante parada global/reconexão podiam escapar do processamento assíncrono como erro não tratado. O cancelamento operacional agora encerra a pendência com rastreamento sem provocar falsa falha de persistência ou uma nova submissão indevida.

Uma configuração anterior que desabilitava comandos privados permanece preservada. Se o privado estiver bloqueado, habilite a opção em BUSCAS; mudar destinatários não contorna autorização ou locais permitidos.

## Funções implementadas

**BUSCAS:** idade máxima padrão de duas horas usando a data original, minutos/horas/desativação, ordenação menor/maior preço ou mais recente, filtros persistentes de produto/capacidade/condição/fornecedor/grupo e seleção/desmarcação dos grupos exibidos com contador. Preço ausente, parcela, entrada e associação ambígua não entram como oferta mais barata. O prefixo continua configurável. Busca privada responde somente ao solicitante autorizado, com ajuda para comando vazio e mensagem clara sem resultados. Os destinatários gerais continuam aplicáveis a grupos/ações do aplicativo.

**Alertas:** teste pelo mesmo fluxo real, ocorrência e entrega separadas, estados e motivo de falha, limite/intervalo de tentativas e pendência enquanto desconectado. O aviso mantém o horário original. ACK significa aceitação; entrega só é declarada quando há recibo. Incertos não são repetidos automaticamente.

**Biblioteca:** modelos persistentes com texto/formatação/mídias/legendas/ordem e uso em rascunho de campanha. Exclusão individual/múltipla de mídias com seleção de todos, prévia e `EXCLUIR`; vínculos a modelos, campanhas, overrides e jobs pendentes/incertos impedem a exclusão. Journal de quarentena recupera exclusões interrompidas.

**LEMBRETES:** horário/fuso Brasília, diário/dias específicos/data única, destinatários cadastrados e habilitados, pausa/ativação/edição/exclusão/teste, próximo aviso e último resultado. Ledger durável impede repetir ocorrência confirmada após reinício. Vencidos podem ser ignorados ou gerar somente o aviso mais recente dentro da tolerância. Backup portátil inclui configurações e restaura pausado; não transfere o ledger de envio. Backup antigo sem lembretes preserva os locais.

**CONTATOS:** mensagens privadas novas de número verificado criam pendência e notificação local ao dono, uma por número enquanto aberta. Nome pode ser editado; categorias são Cliente Nerópolis ou Lojista Camelódromo. Participantes de grupos não viram clientes automaticamente. O contato é salvo somente no sistema: a integração atual não grava na agenda vinculada.

**Administração:** `!mega ajuda`, `!mega menu`, `!mega status` e `!mega parar tudo` funcionam pelo fluxo privado autorizado. `automation.control` é separado da autorização de pesquisar. Parada global pausa campanhas/lembretes, cancela pendências de campanhas/buscas/alertas/lembretes e bloqueia novas entradas após reconexão ou reinício. `!mega retomar sistema` libera as filas; campanhas/lembretes pausados exigem ativação individual. Comandos administrativos continuam disponíveis e envios já submetidos são informados.

## Testes e pendências

Foram executados **454 testes em 29 arquivos**, **6 testes de fachada desktop** e **5 roteiros de interface no Electron real em desktop virtual Linux**, sem falhas na rodada final. A biblioteca Baileys instalada também foi importada sem mocks, sem conectar uma conta. Os testes de transporte usam socket e recibos controlados; SQLite, serviços e renderizadores são os de produção. O relatório [VALIDACAO-2.3.0.md](VALIDACAO-2.3.0.md) identifica as evidências e a verificação dos artefatos.

**Não houve conta WhatsApp real conectada nem Windows físico disponível.** Receber de fato a resposta de `!busca`, alertas/lembretes e comandos no telefone autorizado permanece pendente. Instalação/atualização no Windows, notificações nativas e mixer físico também exigem validação no equipamento. Nenhum teste foi enviado a clientes ou grupos de produção. A aprovação de testes locais e ACKs injetados não comprova recebimento real.

Para a validação pendente, use uma conta conectada e um número de teste autorizado: confira o privado recebido, sua resposta no mesmo número, teste de alerta, aviso pendente após reconexão e lembrete. Use os identificadores de rastreamento para comparar evento, autorização, consulta, destino, fila e confirmação. Não ative campanhas de produção para esse teste. Mantenha aplicativo e notebook ligados, conectados e sem suspensão.
