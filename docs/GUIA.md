# Instalação e uso da versão 2

## Instalar ou atualizar

1. No Windows 10/11 de 64 bits, encerre a versão anterior pelo menu da bandeja e execute **Mega-Disparos-Setup-2.0.0-x64.exe**. Para atualizar, mantenha a pasta Mega Disparos usada anteriormente. O instalador inclui o runtime e cria o atalho no menu Iniciar; o atalho na área de trabalho é opcional.
2. No primeiro acesso, cadastre o **Dono** com usuário e senha de pelo menos 12 caracteres. Guarde os oito códigos de recuperação apresentados uma única vez, fora dos backups comuns. Em uma atualização, campanhas, mídias e configurações anteriores são preservadas e o banco é migrado com cópia de segurança em `backups`.
3. Em uma instalação nova, teste em **Simulação**. A campanha de exemplo tem 15 grupos fictícios, rodadas a cada 10 minutos, espaçamento de 5 segundos e começa desativada. Campanhas anteriores em execução ficam pausadas após a reabertura.

O Windows pode exibir um aviso de editor desconhecido, pois o instalador não tem assinatura de código. Não é preciso instalar Node.js ou usar terminal.

## Criar campanha e conectar

Abra **Campanhas → Nova campanha/Editar**. Adicione textos, emojis, links e arquivos, organize a ordem, selecione destinos e configure dias, janela de horário, datas e limites. Os arquivos são copiados para a biblioteca gerenciada. Escolha repetir o conjunto ou alternar um item por rodada. O intervalo entre rodadas e o espaçamento entre envios são campos diferentes. Salve, visualize a prévia e confirme a ativação; salvar nunca inicia os envios.

Para conectar uma conta real, leia [INTEGRACAO.md](INTEGRACAO.md), selecione WhatsApp em **Configurações**, reconheça que Baileys é **não oficial** e salve. Use Conectar/Reconectar. No celular, leia o QR em WhatsApp → Aparelhos conectados → Conectar aparelho. Atualize **Grupos** e autorize apenas aqueles em que tem permissão para publicar. A campanha real deve selecionar os grupos carregados dessa conta, sem destinos simulados.

Em **Usuários**, vincule o telefone de cada operador, com país e DDD. Em Configurações, cadastre os números autorizados para o controle. De outro número cadastrado, em conversa privada com a conta conectada, envie `!mega ajuda` ou `!mega menu`. Ativação e alterações de campanhas ativas pedem resumo e confirmação com código de uso único. Os comandos respeitam as permissões do usuário; mensagens da própria conta, de grupos, encaminhadas ou sem identidade verificável são ignoradas.

## Usuários e recuperação de senha

O administrador autorizado usa **Usuários → Novo usuário** para cadastrar e aprovar acessos. Selecione Dono, Administrador, Responsável ou Vendedor, ou crie um perfil próprio. A matriz de permissões permite separar visualizar, criar, editar, excluir, iniciar, pausar e encerrar. O vendedor pode acessar apenas suas campanhas ou todas as permitidas. Desativar acesso e editar permissões passa a valer também no backend e nos comandos WhatsApp. O último dono ativo não pode ser excluído ou desativado.

Uma senha temporária pode exigir troca no primeiro login. Para recuperar outro usuário, um administrador autorizado usa **Recuperar senha** e entrega o código temporário ao titular por um meio privado. Na tela de login, a recuperação aceita usuário, código e nova senha; o código só pode ser usado uma vez. O dono pode usar um dos códigos offline guardados no primeiro acesso. Os códigos e as senhas não estão incluídos no backup comum.

Sair do login protege a interface; campanhas já ativadas continuam no serviço em segundo plano. Para interromper os envios, use Pausar/Encerrar ou **PARAR TODOS OS ENVIOS** antes de sair. O botão respeita as campanhas que o usuário tem permissão para encerrar.

## Falhas, avisos e sons

Em **Alertas privados**, cadastre destinatários com país e DDD e use **Testar alerta**. Selecione os destinatários e responsáveis no editor de cada campanha. Donos ativos com telefone cadastrado também recebem os avisos. Uma falha registra a ocorrência, o motivo, o horário original e o resultado de cada privado. O teste cria um aviso privado; não ativa campanhas. Em modo WhatsApp real, o botão envia uma mensagem ao número selecionado.

Se a conexão estiver indisponível, o aviso local aparece imediatamente e o privado fica pendente. Quando houver reconexão, ele mantém o horário original da falha. Confirmado significa ACK da integração ou confirmação manual identificada, sem comprovar leitura. Alertas incertos exigem revisão e não são repetidos automaticamente.

Em **Configurações**, escolha notificações nativas, tentativas e intervalo de reconexão. A retomada automática é opcional e começa desativada: ela só considera campanhas pausadas pela conexão, sem conteúdo alterado ou resultado incerto. Sessão expirada pode exigir novo QR. O aviso interno mostra o horário, motivo conhecido e **Reconectar WhatsApp**.

Configure volume entre 0% e 100%, eventos sonoros, som suave/urgente ou importe WAV, MP3 ou OGG de até 20 MiB. Use um clipe curto, de até 15 segundos: o tempo máximo de reprodução protege a fila de sons; um arquivo que não termine nesse prazo é interrompido e o teste indica falha. Use **Testar som**, ajuste repetição e horário silencioso e silencie uma ocorrência na tela de alertas. O aplicativo evita sons simultâneos. O volume e o mudo do Windows continuam valendo. Notificações e sons dependem do aplicativo em execução, inclusive na bandeja, e das permissões do Windows.

Opcionalmente, configure um endpoint **HTTPS** independente e um token em Configurações. Esse recurso exige um serviço externo sob sua responsabilidade. O aplicativo envia a ocorrência ao endpoint; “aceito pelo canal” não significa mensagem entregue no WhatsApp.

## Histórico, diagnóstico e limpeza

**Histórico** e **Diagnóstico** têm filtros e paginação. Diagnóstico mostra etapa, código, descrição sanitizada, tentativas, ação tomada e orientação; oferece copiar detalhes e exportar. Relatórios permitem consultar e exportar os resultados dentro das permissões do usuário.

Envios incertos precisam de verificação na conversa real e revisão manual: marque confirmado somente depois de conferir o envio, ou descarte sem repetição automática. A lista de revisões usa o controle operacional e permanece disponível após a limpeza dos registros visíveis.

A exclusão de uma campanha é bloqueada enquanto houver envio incerto ligado a ela, para manter acesso à revisão. Confira e resolva os resultados antes de excluir a campanha.

Para limpar registros, entre com o dono ou com um usuário que tenha a permissão **Apagar históricos**. Em Configurações, escolha **Apagar todos os históricos**, selecione campanhas, envios, erros/diagnóstico e/ou notificações, confira as quantidades, exporte se necessário e digite **APAGAR** exatamente. Se novos registros alterarem a prévia, atualize-a antes de confirmar.

Essa limpeza preserva usuários, contatos, grupos, mídias, modelos, configurações e campanhas. Também preserva jobs, rodadas, alertas operacionais e auditoria: são necessários para impedir duplicidade e registrar quem limpou. Por isso, contadores operacionais podem continuar no painel mesmo com o histórico visível vazio. Ajuste a retenção de registros em Configurações; ela não remove o controle contra duplicidade nem a auditoria.

## Backup e funcionamento diário

Use **Configurações → Backup** para exportar campanhas, biblioteca e configurações compartilháveis. Guarde o arquivo em local privado: ele contém mensagens, arquivos e telefones. Não inclui usuários, senhas, recuperação, sessão WhatsApp, token do canal, áudio personalizado ou históricos. A restauração exige permissões globais, faz backup automático anterior, preserva usuários/perfis e deixa as campanhas desativadas em simulação. Revise os destinos antes de voltar à conexão real.

**PARAR TODOS OS ENVIOS** cancela itens ainda pendentes. Uma mensagem já submetida pode concluir e não é recolhida. Minimizar para a bandeja mantém o aplicativo funcionando; encerrar interrompe os agendamentos. A opção de iniciar com o Windows inicia o aplicativo, mas não ativa campanhas por conta própria.

Mantenha o computador ligado, com internet e sem suspensão. Após suspensão, desconexão ou reinício, confira resultados e conexão antes de retomar. Não há acúmulo de rodadas perdidas. Os dados locais ficam em `%APPDATA%\Mega Disparos`.

Consulte [VALIDACAO.md](VALIDACAO.md). Não foram feitos envios reais nem testes em Windows físico neste ambiente. Notificações físicas, mixer de áudio, instalação e transporte WhatsApp real ainda precisam dessa validação; envios de teste reais devem ocorrer somente no grupo indicado pelo usuário.
