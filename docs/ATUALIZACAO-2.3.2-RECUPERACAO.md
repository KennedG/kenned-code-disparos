# Atualização 2.3.2 — recuperacao-r2

Esta revisão usa exclusivamente a entrega verificada **2.3.2 — reformulado-r1**. Mantém a versão numérica 2.3.2 e acrescenta correções de grade de rodadas, recuperação técnica, alertas persistentes e captura de publicações. Não acrescenta vendas, caixa, financeiro, custos, margens nem comparação automática de ofertas equivalentes. O menu, Oportunidades, modelos, BUSCAS, Excel, lembretes e Vitrine TV permanecem disponíveis conforme as permissões e a licença.

O instalador desta revisão é **Kenned-Code-Disparos-Setup-2.3.2-Recuperacao-x64.exe**. O serviço de licenciamento, o cliente criptográfico, a chave pública, a política de expiração, as licenças existentes e a identidade do dispositivo permanecem os mesmos da revisão anterior. O instalador não contém chaves comerciais ou credenciais administrativas.

## Defeitos identificados no código anterior

A revisão anterior calculava o próximo horário a partir do último início efetivo de envio, em vez de usar a abertura da janela como âncora. Um início atrasado podia, portanto, deslocar a grade seguinte. O cálculo atual usa os horários da janela e pula os já passados.

Eventos `messages.upsert` do tipo `append` eram tratados indiscriminadamente como histórico na captura de BUSCAS; a Origem da loja também os classificava como históricos. Uma publicação nova encaminhada pela integração nesse tipo de evento podia ficar de fora quando a importação de histórico estava desativada. A classificação atual separa eventos recentes realmente observados em sessão pronta de histórico ou recuperação não solicitada; as proteções de autorização e duplicidade permanecem.

O processo anterior não conservava uma autorização de recuperação ligada à data, programação e rodada pendente; a recuperação podia exigir nova ação manual e não tinha a grade correta para esperar. A revisão registra essa autorização e separa interrupção técnica de pausa manual. O alarme persistente por incidente e a evidência de teste de captura também são comportamentos novos.

Esses são defeitos ou lacunas demonstráveis no código e nos testes controlados. Não são uma confirmação de que a sessão particular do cliente em produção falhou exatamente por essas causas: sua captura e o recebimento real ainda precisam ser acompanhados na sessão autorizada.

## Atualizar com possibilidade de recuperação

1. Pause as campanhas e encerre o aplicativo pela bandeja. Fechar a janela pode apenas minimizá-la.
2. Faça uma cópia privada da pasta inteira **`%APPDATA%\Mega Disparos`** com o aplicativo encerrado. Inclua banco, mídias e arquivos do perfil. Não misture banco e WAL/SHM de momentos diferentes. Guarde também o instalador **reformulado-r1** compatível com essa cópia.
3. Preserve **`%LOCALAPPDATA%\KennedCodeDisparos-Licensing`** e a âncora **`HKCU\Software\KennedCodeDisparos\Licensing`**. Não apague a identidade para tentar reiniciar o teste, nem transfira credenciais protegidas para outro dispositivo.
4. Instale o novo `.exe` na mesma pasta dedicada. O identificador `br.com.megadisparos.desktop` e o perfil legado continuam iguais; o uso diário dispensa terminal ou Node.js.
5. Abra o aplicativo e confira licença, usuários, campanhas, modelos, mídias, contatos, grupos, responsáveis, BUSCAS e configurações. Revise os horários do Windows antes de retomar uma campanha.

Antes da preparação do banco existente, o aplicativo cria e verifica um snapshot SQLite consistente, identificado por **`2.3.2-recuperacao-r2`**. Uma falha nessa cópia impede a preparação da revisão. A cópia automática cobre o banco; não substitui o backup integral do perfil e das mídias. Os arquivos protegidos por DPAPI continuam vinculados ao usuário e equipamento Windows correspondentes.

A alteração da política de reconexão é aplicada uma vez quando a configuração ainda não registra `policyVersion: 2`: reconexão por erro e recuperação autorizada passam a ficar habilitadas conforme esta solicitação. Depois disso, alterações feitas pelo usuário são preservadas. O restante das configurações permanece salvo. A ação é auditada; pausas e desconexões manuais não viram autorização para retomar.

## Rodadas pelo relógio do computador

As campanhas executam pela **data, hora e fuso local do Windows**. O painel mostra o relógio do computador, a última rodada, a próxima rodada e a situação da campanha. O fuso registrado anteriormente permanece como dado; não substitui o relógio oficial de execução nesta revisão. O fuso das mensagens originais, das pesquisas e dos lembretes continua seguindo suas próprias configurações.

Cada janela permitida estabelece a grade. Início **08:00**, término **18:00** e intervalo **10 minutos** produzem horários **08:00, 08:10, 08:20…17:50**. O horário de término é exclusivo: não começa nem continua envio às 18:00. Uma rodada que termina tarde não desloca a grade; horários perdidos são pulados e não há sobreposição de rodadas da mesma campanha. Os intervalos entre itens e grupos são controles separados do intervalo entre rodadas.

A conexão e a janela são verificadas novamente antes de cada submissão. O aplicativo reavalia a programação quando detecta mudança de hora, fuso ou retorno da suspensão. O relógio do Windows deve estar correto; este ajuste não altera a fonte confiável de tempo usada pelo licenciamento. Janelas que atravessam meia-noite continuam ligadas ao dia em que começam; início e término iguais representam uma janela de 24 horas.

## Reconexão e recuperação autorizada

Uma desconexão por erro inicia tentativas limitadas com intervalos progressivos e limite de espera configurável, reutilizando a sessão disponível. A sessão precisa estar pronta para envio. A necessidade de novo QR Code é exibida e registrada; a desconexão escolhida pelo usuário não dispara reconexão automática.

O início manual autorizado é persistido com data local, fuso e programação. Após um erro, a recuperação somente rearma uma campanha com autorização preservada para aquele incidente e programação compatível. Campanhas nunca iniciadas, pausadas, canceladas ou encerradas manualmente não são ativadas pela recuperação. Uma pausa geral, vencimento de licença ou troca de integração também conserva seus bloqueios.

Ao recuperar, a tela informa **“Conexão recuperada — aguardando próximo horário de rodada”**. Reconectar às **14:07**, com grade **14:00, 14:10, 14:20**, permite continuar apenas às **14:10**. Se a janela terminou, o próximo horário é calculado para o dia permitido seguinte, sem criar nova autorização de execução nem compensar todas as rodadas perdidas.

Uma rodada interrompida conserva seus itens e destinos congelados. No próximo horário elegível, pendências não submetidas continuam na própria rodada, mantendo o identificador original; isso não representa uma nova rodada de repetição. Mensagens já aceitas ou entregues não são reenviadas. Uma tentativa interrompida sem prova fica **incerta**, pode ser reconciliada por evidências da integração e não autoriza reenvio automático. As demais tarefas elegíveis continuam; reenvio manual exige aviso de possível duplicação.

Reabrir o aplicativo e voltar da suspensão reaplicam esses controles. Configurações alteradas depois da interrupção podem exigir revisão manual, em vez de assumir que a autorização antiga cobre o novo conteúdo ou agendamento.

## Incidentes, alertas privados e alarme

Em **Configurações → Destinatários dos avisos**, cadastre ou selecione um responsável autorizado com país e DDD. O botão de teste utiliza a fila real de alertas; entrar na fila não significa enviado. A interface distingue pendente, processando, envio aceito, entrega confirmada quando existe recibo, falha e resultado incerto. Um resultado incerto não é repetido automaticamente.

Cada incidente conserva campanha, horário original, motivo, pendências e rastreamento. Avisos repetidos do mesmo incidente são agrupados. Se o WhatsApp estiver desconectado, o aviso local aparece imediatamente e o alerta privado aguarda conexão. Após a recuperação, o alerta pode sair antes da próxima rodada da campanha e informa o horário original e o horário da recuperação. Falha ao enviar o alerta não inicia uma cascata de novos alertas.

Um incidente que impede os envios pode restaurar a janela e solicitar primeiro plano uma única vez. O Windows pode impedir o foco; nesse caso há destaque na barra de tarefas e notificação quando disponíveis. Som, áudio próprio, volume, intervalo e horário silencioso são configuráveis. O alarme persistente permanece enquanto o incidente estiver ativo, respeitando som habilitado e volume/mudo do Windows. **Silenciar alarme** interrompe somente o som daquele incidente; o aviso continua. Uma recuperação confirmada encerra o alarme, e um incidente novo pode voltar a alertar. Não há sobreposição de sons do mesmo incidente.

Use **Testar conexão** e **Ver detalhes do erro** no aviso. Notificações e áudio dependem de o aplicativo estar em execução, inclusive na bandeja, e das permissões do Windows. Funcionamento com a máquina desligada não é possível.

## Origem da loja: diagnóstico da captura

Selecione um grupo real da sessão; a configuração usa seu **ID**, mantendo o vínculo mesmo se o nome mudar. Configure os participantes autorizados e, quando desejado, permita suas publicações manuais pela conta conectada. Mensagens produzidas automaticamente pelo aplicativo não criam novas publicações ou comandos; legendas são conteúdo, não instruções.

**Sincronizar agora** atualiza grupos e monitoramento. Não inicia disparos, não recupera mensagens antigas e não remove a pausa decorrente da exclusão da campanha vinculada.

**Testar captura** verifica sessão, grupo e assinaturas e fica aguardando uma publicação nova autorizada. Publique um texto ou foto com legenda no grupo selecionado. O teste somente é confirmado quando a publicação está persistida e o item da campanha está pronto, incluindo a mídia salva quando aplicável. Apenas armar o teste não é sucesso. O prazo padrão de espera é de dois minutos.

A tela identifica grupo, situação, última mensagem, último item pronto, última sincronização, último erro e possíveis lacunas. Texto, imagem com legenda e mídias compatíveis mantêm seus identificadores e associações. Falha de download permanece registrada sem bloquear os outros itens. Repetição de evento, reinício ou reconexão não cria outro item com o mesmo identificador original.

A pausa persistente após excluir campanha continua em vigor: crie ou vincule uma campanha e confirme a retomada. Por padrão somente publicações posteriores à retomada entram. Histórico exige período explicitamente escolhido, depende da integração e pode ser incompleto. Álbum, edições e exclusões dependem dos eventos efetivamente disponibilizados.

## BUSCAS e respostas privadas

Ative BUSCAS e selecione **grupos monitorados** reais. Eles não são a lista de pessoas autorizadas nem os locais que aceitam comandos. **Sincronizar** atualiza os grupos e monitoramento; **Testar captura** aguarda uma mensagem nova de um grupo monitorado e mostra a evidência efetivamente capturada. Confira contagem de mensagens, ofertas indexadas, última captura, última sincronização e erros.

As mensagens capturadas preservam texto, identificador, grupo, remetente confiável e data original. Listas são divididas em ofertas vinculadas à mensagem. Número inexistente não é inventado; LID não vira telefone fictício. A idade máxima padrão de duas horas, os demais filtros e a ordenação persistida continuam disponíveis. Parcelas, entradas e preço de outro produto não viram preço total confirmado.

Comandos privados respondem exclusivamente ao solicitante autorizado, na mesma conversa. A seleção de responsáveis para listas ou alertas não altera esse destino. Prefixo configurável, autorização no backend e prevenção de eventos duplicados continuam obrigatórios.

```text
!busca iPhone 15 Pro Max 256GB
!busca
!busca --excel iPhone 15 Pro Max 256GB
!busca --ambos iPhone 15 Pro Max 256GB
!mega ajuda
!mega menu
!mega status
!mega parar tudo
```

O último comando deve ser testado apenas em ambiente controlado: interrompe automações, preserva os dados e exige retomada explícita. Comandos administrativos precisam de permissão administrativa; autorização para pesquisar não concede controle do sistema.

## Identidade visual e recursos preservados

A marca conserva **Kenned Code Disparos** e usa símbolo próprio KC, assinatura horizontal e variantes para fundos claros, escuros e transparentes. Os vetores e imagens ficam em `assets`, incluindo ícone multirresolução do aplicativo e ícone da bandeja. Preserve a proporção ao reutilizá-los; o guia `assets/BRAND.txt` identifica cada arquivo.

Licença vencida continua permitindo apenas a área de licença; nenhuma recuperação técnica ignora esse bloqueio. Renovar não retoma campanhas automaticamente. Grupos e ofertas fictícios continuam exclusivamente na simulação, identificada como **SIMULAÇÃO — DADOS FICTÍCIOS**; a simulação não envia para contatos reais.

## Voltar à revisão anterior

1. Encerre o aplicativo e guarde uma segunda cópia integral do perfil atual, preservando os registros posteriores à atualização.
2. Reinstale **reformulado-r1**, sem abrir ainda, e restaure a cópia integral feita antes desta revisão. Use banco, mídias e arquivos do mesmo momento.
3. Conserve a identidade atual da licença e suas âncoras externas no mesmo Windows. Não reduza `PRAGMA user_version`, não apague tabelas e não resete os dados.
4. Abra com campanhas pausadas e confira licença e envios ocorridos depois do backup antes de autorizar qualquer retomada.

Restaurar um banco antigo não desfaz mensagens já recebidas; perder seus registros de deduplicação e retomar sem revisão pode duplicá-las. Por isso o perfil atual precisa ser guardado para comparação. A compatibilidade específica de um banco particular que não foi acessado não pode ser certificada por testes com fixtures.

## Validação e pendências

Consulte [o roteiro de validação desta revisão](VALIDACAO-2.3.2-RECUPERACAO.md) e o relatório entregue junto ao instalador. Cada evidência distingue teste automatizado, integração controlada, execução do conteúdo empacotado, aceitação pela integração real, entrega confirmada e recebimento no celular.

O número particular de teste foi informado pelo dono e fica fora dos arquivos públicos. Neste ambiente não há sessão da loja conectada nem equipamento Windows físico. Portanto permanecem pendentes a captura e busca reais, a recepção dos alertas nesse celular, a leitura do Excel recebido, a instalação Windows, DPAPI, suspensão física, som, notificações e política de foco do Windows. Não escolha clientes nem o contato do desenvolvedor como substitutos.

Baileys é **não oficial**. Histórico, comunidades, identificação PN/LID, álbum, edição/exclusão e recibos dependem da sessão e dos eventos reais. O instalador está sem assinatura de código. Esta revisão deve ser tratada como **candidata à validação real**, sem declarar recebimento real com base apenas em testes controlados ou filas.
