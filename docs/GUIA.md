# Instalação e uso da versão 2.1.0

## Instalar ou atualizar

1. No Windows 10/11 de 64 bits, encerre a versão anterior pelo menu da bandeja e execute **Mega-Disparos-Setup-2.1.0-x64.exe**. Para atualizar, mantenha a pasta Mega Disparos usada anteriormente. O instalador inclui o runtime e cria o atalho no menu Iniciar; o atalho na área de trabalho é opcional.
2. No primeiro acesso, cadastre o **Dono** com usuário e senha de pelo menos 12 caracteres. Guarde os oito códigos de recuperação apresentados uma única vez, fora dos backups comuns. Em uma atualização, campanhas, mídias e configurações anteriores são preservadas e o banco é migrado com cópia de segurança em `backups`.
3. Em uma instalação nova, teste em **Simulação**. A campanha de exemplo tem 15 grupos fictícios, rodadas a cada 10 minutos, espaçamento de 5 segundos e começa desativada. Campanhas anteriores em execução ficam pausadas após a reabertura.

A atualização para 2.1.0 preserva campanhas, arquivos, usuários e configurações. **BUSCAS começa desativado** e tem configurações próprias; selecionar grupos para monitorar ofertas não altera os destinos das campanhas.

O Windows pode exibir um aviso de editor desconhecido, pois o instalador não tem assinatura de código. Não é preciso instalar Node.js ou usar terminal.

## Criar campanha e conectar

Abra **Campanhas → Nova campanha/Editar**. Adicione textos, emojis, links e arquivos, organize a ordem, selecione destinos e configure dias, janela de horário, datas e limites. Os arquivos são copiados para a biblioteca gerenciada. Escolha repetir o conjunto ou alternar um item por rodada. O intervalo entre rodadas e o espaçamento entre envios são campos diferentes. Salve, visualize a prévia e confirme a ativação; salvar nunca inicia os envios.

Para conectar uma conta real, leia [INTEGRACAO.md](INTEGRACAO.md), selecione WhatsApp em **Configurações**, reconheça que Baileys é **não oficial** e salve. Use Conectar/Reconectar. No celular, leia o QR em WhatsApp → Aparelhos conectados → Conectar aparelho. Atualize **Grupos** e autorize apenas aqueles em que tem permissão para publicar. A campanha real deve selecionar os grupos carregados dessa conta, sem destinos simulados.

Em **Usuários**, vincule o telefone de cada operador, com país e DDD. Em Configurações, cadastre os números autorizados para o controle. De outro número cadastrado, em conversa privada com a conta conectada, envie `!mega ajuda` ou `!mega menu`. Ativação e alterações de campanhas ativas pedem resumo e confirmação com código de uso único. Os comandos respeitam as permissões do usuário; mensagens da própria conta, de grupos, encaminhadas ou sem identidade verificável são ignoradas.

## Usuários e recuperação de senha

O administrador autorizado usa **Usuários → Novo usuário** para cadastrar e aprovar acessos. Selecione Dono, Administrador, Responsável ou Vendedor, ou crie um perfil próprio. A matriz de permissões permite separar visualizar, criar, editar, excluir, iniciar, pausar e encerrar. O vendedor pode acessar apenas suas campanhas ou todas as permitidas. Desativar acesso e editar permissões passa a valer também no backend e nos comandos WhatsApp. O último dono ativo não pode ser excluído ou desativado.

Uma senha temporária pode exigir troca no primeiro login. Para recuperar outro usuário, um administrador autorizado usa **Recuperar senha** e entrega o código temporário ao titular por um meio privado. Na tela de login, a recuperação aceita usuário, código e nova senha; o código só pode ser usado uma vez. O dono pode usar um dos códigos offline guardados no primeiro acesso. Os códigos e as senhas não estão incluídos no backup comum.

Sair do login protege a interface; campanhas já ativadas continuam no serviço em segundo plano. Para interromper os envios, use Pausar/Encerrar ou **PARAR TODOS OS ENVIOS** antes de sair. O botão respeita as campanhas que o usuário tem permissão para encerrar.

## Configurar BUSCAS

1. Entre com o **Dono** e abra **BUSCAS → Configurações**. Cadastre primeiro, em Usuários, o telefone real do dono que receberá resultados, com código do país e DDD.
2. Selecione os **Grupos monitorados** onde recebe anúncios dos fornecedores. Em outra lista, selecione os **Grupos que aceitam comandos**. Você pode monitorar um grupo sem aceitar comandos nele e habilitar comandos em um grupo que não será capturado.
3. Para comandos privados, ative a opção correspondente e informe as conversas habilitadas. Os números precisam pertencer a usuários locais ativos. A conversa habilitada é onde a solicitação chega à conta conectada, não um fornecedor a ser contatado.
4. Mantenha `!busca` ou altere o prefixo. O exemplo da tela acompanha a alteração. Escolha até dez resultados, validade de 24 horas, três dias, sete dias ou período personalizado. O fuso inicial é **America/Sao_Paulo**; o período exibido e as datas originais seguem o fuso configurado.
5. Escolha o critério de preço, filtros, retenção de mensagens, sinônimos, bloqueios, limite de buscas por pessoa e, se desejado, um resultado por fornecedor. O padrão considera o **preço total anunciado à vista**, do menor para o maior.
6. Em Destinatários, mantenha **Privado do dono** e selecione o dono com telefone. Alternativamente, escolha solicitante autorizado, responsáveis previamente cadastrados em Alertas ou conversa de origem. Publicar na origem exige habilitação explícita adicional. Não haverá contato automático com fornecedores.
7. Ative o módulo, salve e mantenha o aplicativo conectado. A tela mostra início, última sincronização, fila e lacunas. Atualizar a tela não consulta repetidamente o histórico do WhatsApp.

Em **BUSCAS → Autorizados**, o dono ou uma pessoa com gestão explícita do módulo seleciona usuários locais ativos, concede Buscar, Consultar histórico, Alterar filtros e/ou Gerenciar o módulo, e pode editar, desativar ou remover os acessos. O perfil em **Usuários** também precisa das permissões BUSCAS correspondentes. Apenas ser administrador do grupo, fornecedor monitorado ou ter um nome conhecido não concede acesso. Usuários desativados ou com troca obrigatória de senha pendente não podem usar o módulo. Comandos não autorizados são ignorados silenciosamente.

## Pesquisar pelo WhatsApp e pelo aplicativo

Em um local habilitado e a partir de um usuário autorizado, envie:

```text
!busca 18 pro Max Silver
!busca iPhone 18 Pro Max 256GB Silver
!busca iPhone 15 128GB lacrado
!busca Samsung S24 Ultra 256GB
```

O prefixo deve estar no início. Maiúsculas e minúsculas são equivalentes; `ProMax`/`Pro Max` e `Silver`/`Prata` são reconhecidos. Enviar apenas `!busca` dá uma orientação curta. Ao mudar o prefixo, use o novo comando; os comandos antigos de campanhas continuam com `!mega`.

Modelo e versão são obrigatoriamente compatíveis. Quando capacidade, cor ou condição não forem filtradas, cada resultado mostra o que foi anunciado ou “não informado”. Para restringir, acrescente capacidade/cor/condição ao comando ou ajuste filtros na tela. Filtros desconhecidos pedem esclarecimento; não ampliam silenciosamente a busca para outros modelos. O resultado tem até dez ofertas; se houver menos, retorna somente elas. Sem compatíveis, informa a ausência.

Em **BUSCAS → Pesquisar**, descreva o aparelho e consulte localmente. A ação **Enviar aos destinatários configurados** registra uma entrega explícita; pesquisar na tela não publica no WhatsApp por conta própria. Em modo Simulação, o formulário de anúncio fictício permite testar captura e ranking sem conectar conta ou contactar ninguém.

Os resultados incluem preço anunciado, fornecedor, número real quando disponível, trecho original, condições, grupo e data da mensagem. Nome salvo e nome exibido aparecem separados quando diferentes. **Número indisponível** significa que a integração não entregou telefone confiável; o aplicativo não converte LID em número. Telefone escrito na oferta é mostrado como contato informado, sem substituir a identidade do remetente. Encaminhamentos mostram que a identidade do fornecedor original pode ser desconhecida. A informação é um anúncio capturado: confirme disponibilidade e condições com o fornecedor.

## Revisar ofertas, captura e dados de BUSCAS

Em **Ofertas capturadas**, filtre associações confirmadas ou aguardando revisão. Listas claras geram uma oferta por aparelho/capacidade/cor. Parcelas, entradas, descontos e acessórios não são considerados preço total. “A partir de”, compra mínima e lote mantêm seus qualificadores e exigem o critério correspondente. Associação ambígua fica fora do ranking. Use **Mensagem original** para conferir o texto local e **Revisar dados**, com permissão de gestão, somente após verificar o anúncio; não invente preço nem características.

A publicação mais recente do mesmo fornecedor e combinação de modelo, capacidade, cor e condição prevalece sobre a anterior, mesmo que o preço antigo fosse menor. Condições diferentes continuam separadas. Indisponibilidade elimina a oferta anterior somente quando a associação é inequívoca. Edições e exclusões são aplicadas quando os eventos chegam; não há garantia de receber mudanças durante períodos sem conexão.

**Histórico** registra solicitante, origem, filtros, horário e resultado da pesquisa. Entregas podem estar pendentes, confirmadas, falhas ou incertas. Confirmado exige ACK do serviço; não comprova leitura. Ao desconectar, a captura fica desatualizada e resultados exibem o aviso. Entregas ainda não submetidas podem sair após reconexão; as incertas exigem revisão e não são repetidas automaticamente.

Em **Dados e limpeza**, as duas ações têm efeitos diferentes:

- **Apagar histórico de buscas:** remove os registros visíveis das consultas e preserva mensagens, ofertas e controles de entrega/deduplicação.
- **Excluir base de ofertas:** remove mensagens/anúncios capturados e ofertas, esvaziando a pesquisa. Preserva campanhas, mídias, usuários, configurações, histórico de consultas, auditoria e controles operacionais.

Confira a prévia e digite **APAGAR**. Essas ações exigem gestão explícita e ficam em auditoria; a limpeza geral de históricos de campanhas não substitui essa limpeza. A retenção elimina mensagens antigas e ofertas associadas; por isso a base pode ser menor que o período desejado para a busca.

Importação de histórico anterior é **parcial e oportunista**. Habilitá-la permite aproveitar apenas os eventos que a integração realmente disponibilizar. Ela não recupera tudo de grupos/comunidades nem garante preencher lacunas. Aplicativo fechado, desconexão, grupos inacessíveis e filas excedidas podem deixar períodos sem captura. Leia [BUSCAS-INTEGRACAO.md](BUSCAS-INTEGRACAO.md).

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

Use **Configurações → Backup** para exportar campanhas, biblioteca e configurações compartilháveis. Guarde o arquivo em local privado: ele contém mensagens, arquivos e telefones. O backup portátil não inclui usuários, senhas, recuperação, sessão WhatsApp, token do canal, áudio personalizado, históricos nem **base, configurações ou autorizações de BUSCAS**. Esses dados ficam no banco local. A restauração exige permissões globais, faz backup automático anterior, preserva usuários/perfis e BUSCAS locais e deixa as campanhas desativadas em simulação. Revise os destinos e os grupos de monitoramento antes de voltar à conexão real. A cópia SQLite anterior à migração contém os dados locais, inclusive os capturados, e deve permanecer protegida.

**PARAR TODOS OS ENVIOS** cancela itens ainda pendentes. Uma mensagem já submetida pode concluir e não é recolhida. Minimizar para a bandeja mantém o aplicativo funcionando; encerrar interrompe os agendamentos. A opção de iniciar com o Windows inicia o aplicativo, mas não ativa campanhas por conta própria.

Mantenha o computador ligado, com internet e sem suspensão. Após suspensão, desconexão ou reinício, confira resultados e conexão antes de retomar. Não há acúmulo de rodadas perdidas. Os dados locais ficam em `%APPDATA%\Mega Disparos`.

Consulte [VALIDACAO.md](VALIDACAO.md). Não foram feitos envios reais nem testes em Windows físico neste ambiente. Notificações físicas, mixer de áudio, instalação e transporte WhatsApp real ainda precisam dessa validação; envios de teste reais devem ocorrer somente no grupo indicado pelo usuário.

O campo de teste no aplicativo aceita a descrição ou o comando completo com o prefixo configurado. A consulta é local; o botão de entrega envia aos destinatários configurados após a ação explícita. O histórico distingue consulta local, pendente, confirmado pelo servidor, falha e resultado incerto, com o destino correspondente. Ofertas ambíguas não participam do ranking. A revisão pode confirmar um preço total verificado; ambiguidade de modelo, capacidade ou cor permanece para revisão ou descarte, preservando a mensagem.

![BUSCAS com anúncios fictícios](buscas-resultados.png)
