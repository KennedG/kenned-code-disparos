# Kenned Code Disparos 2.3.2 · R10

Base: 2.3.2 R9, conservando a identidade de instalação e o perfil `%APPDATA%\Mega Disparos`. Não há módulos de vendas, estoque comercial, caixa ou financeiro. Baileys é uma integração **não oficial**.

## Atualizar

1. Pare os envios e encerre o aplicativo também pela bandeja.
2. Guarde uma cópia privada da pasta `%APPDATA%\Mega Disparos` e mantenha o instalador anterior. Essa cópia pode conter dados pessoais e sessão protegida: não a publique nem envie ao GitHub.
3. Execute o instalador R10 no mesmo usuário Windows. Não exclua o perfil. Abra o aplicativo e confira versão, campanhas, responsáveis e licença antes de iniciar envios.
4. Na primeira abertura sobre um banco existente, é criada uma cópia SQLite `backups\pre-revisao-r10-*.sqlite`, validada com `PRAGMA quick_check`, antes das configurações desta revisão. Se não for possível gravá-la, a inicialização é interrompida. Essa cópia não substitui o backup completo das mídias e do perfil.

Não foi alterado o número do esquema do banco. A chave pública de licenciamento, o serviço de licença e a proteção da sessão continuam os existentes. Não há lista de chaves administrativas no instalador.

## Recuperar a versão anterior

Encerre completamente o aplicativo e reinstale a R9. Guarde primeiro uma cópia do perfil atual, principalmente se já cadastrou dados novos. Se precisar voltar ao estado anterior à atualização, restaure **a cópia completa do perfil** com o aplicativo fechado. A cópia SQLite pré-R10 pode substituir `mega.sqlite` somente com todos os processos fechados, preservando uma cópia do banco atual e sem reaproveitar arquivos `-wal`/`-shm` de outro banco. Peça suporte se não tiver segurança nessa operação. Restaurar o estado antigo remove alterações posteriores; não misture bancos de versões ou mídias de outra loja.

Credenciais protegidas pelo Windows não são portáveis para outro usuário/computador. Uma restauração noutro dispositivo pode exigir nova conexão. Não contorne a licença nem apague dados para tentar reiniciá-la.

## Reconexão e sincronização

Em Configurações, revise reconexão, limite de tentativas, intervalos progressivos e o novo prazo de detecção de conexão travada (15 a 180 segundos; padrão 45). A escolha manual de desconectar continua impedindo recuperação automática. QR Code e sessão expirada exigem intervenção quando indicado.

A abertura do socket é seguida por consulta autenticada ao servidor. Uma verificação operacional limitada a cada dois minutos detecta uma sessão sem resposta, sem enviar mensagens de teste. Isso não garante permissão de publicação em todos os grupos: cada envio conserva suas verificações e seus recibos.

“Aguardando mensagem” indica que o conteúdo original não chegou decifrado. Há contadores e rastreamento para conteúdo pendente, recuperado e não recuperado no prazo. A biblioteca pode recuperar conteúdo posteriormente; o aplicativo não inventa textos nem promete recuperar mensagens que o WhatsApp não fornecer. Avisos administrativos sobre conteúdos indisponíveis são agrupados em intervalos de 15 minutos. Comandos antigos não são executados retroativamente.

## UPTIME

Em Mais ferramentas → Automação → UPTIME, escolha um intervalo de 5 minutos a 7 dias e destinatários autorizados. Os particulares precisam estar vinculados a usuários com permissão de diagnóstico; grupos precisam ser reais, acessíveis e autorizados no modo atual. Salve antes de testar.

O módulo nasce desativado. Selecionar um grupo é autorização explícita para publicar nele o relatório operacional. Escolha cuidadosamente: ele pode conter totais internos de campanhas e erros. As seções são configuráveis. O relatório identifica período dos contadores, processo medido e diferença entre aceitação e entrega. `!status` mantém o resumo de Oportunidades e, para administrador com diagnóstico, acrescenta as informações do UPTIME; `!mega status` também informa a programação do módulo.

É necessário computador ligado, aplicativo em execução e conexão disponível. Não é monitor externo: com o aplicativo desligado ele não pode informar que ficou offline. Não são acumulados relatórios para todos os intervalos perdidos. Um relatório pendente evita novas cópias automáticas enquanto aguarda processamento. A parada geral e a licença bloqueiam novas submissões.

## Contato privado em Oportunidades

O fluxo já existente de ofertas para **destinos da campanha** permanece. A ação separada **Chamar no privado** resolve o participante da mensagem original e abre uma mensagem editável. Revise e confirme que o contato foi solicitado ou é permitido. Não foi habilitado um novo disparo privado automático para participantes.

Quando houver correspondência segura com item da campanha, o texto e sua mídia gerenciada podem ser preparados. Sem correspondência não são inventados anúncio, disponibilidade, preço ou estoque. A identidade PN/LID precisa ser resolvida pela integração. Sem telefone confiável não há envio nem substituição pelo grupo.

Fila, aceitação, entrega, leitura, falha e resultado incerto são diferentes. Consulte Histórico privado para rastreio e resultado individual. Resultado incerto não é repetido: **Verificar resultado** consulta a evidência disponível; **Nova tentativa manual** avisa sobre duplicação e revalida permissões, validade e bloqueios. Nem sempre a integração consegue provar o destino final ou recuperar um recibo antigo.

## Buscas e campanhas

A pesquisa de **ofertas** e seus filtros, incluindo idade máxima padrão de duas horas e exportação Excel, foi preservada. A seção **Mensagens dos grupos — pesquisa por conteúdo** acrescenta termos combinados, frases entre aspas, acentos, grupo, período, identificador de remetente, relevância/data e paginação. Ela consulta somente mensagens efetivamente capturadas. Uma procura reconhecida por regras fixas pode criar uma oportunidade para revisão, sem disparar automaticamente um novo contato.

O editor preserva rolagem e campos ao voltar do seletor de mídia, inclui prévia leve e permite substituir o arquivo mantendo a legenda. Salvar/editar não autoriza campanhas nem altera seu agendamento.

## Limites operacionais

O novo registro privado/UPTIME é separado por modo. Ao atingir o limite de histórico (configuração geral, até 20.000 registros nesse serviço), registros terminais com mais de 48 horas podem ser compactados, mantendo comprovante mínimo de deduplicação. Pendentes e incertos não são eliminados. Se só houver trabalho recente ou não resolvido, a capacidade bloqueia novas reservas com erro explícito. Limpar um histórico não autoriza reenviar convites ou oportunidades.

A versão foi verificada com testes automatizados, sockets controlados e Electron em Linux, incluindo o código empacotado. **WhatsApp real, recebimento no celular, notificações/DPAPI e instalação física Windows exigem homologação no ambiente autorizado do usuário.** Os resultados específicos acompanham a entrega. Não use clientes como destinatários de teste.
