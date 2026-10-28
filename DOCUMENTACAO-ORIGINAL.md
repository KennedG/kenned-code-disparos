# Mega Disparos 2.1.0

Aplicativo local para Windows 10/11 x64, com interface em português, campanhas de texto e mídias para grupos autorizados, fila persistente e controle por conversa privada no WhatsApp. A versão **2.1.0** acrescenta **BUSCAS**: captura ofertas recebidas dos grupos selecionados, separa listas de aparelhos e responde a pesquisas autorizadas pelo WhatsApp ou pelo aplicativo, preservando as campanhas e configurações existentes.

Execute **Mega-Disparos-Setup-2.1.0-x64.exe**. O runtime está incluído: o uso diário não exige Node.js nem terminal. O instalador cria um atalho no menu Iniciar e permite criar outro na área de trabalho. O executável não tem certificado de assinatura de código; o Windows pode mostrar um aviso de editor desconhecido.

## Primeiros passos

1. No primeiro acesso, cadastre o **Dono**, use uma senha de pelo menos 12 caracteres e guarde os oito códigos de recuperação mostrados uma única vez. Depois disso, novos usuários são cadastrados por um administrador autorizado.
2. Uma instalação nova começa em **Simulação**, com 15 grupos fictícios e uma campanha **desativada**, a cada 10 minutos, das 08:00 às 18:00, todos os dias. Nenhuma conta real é conectada nesse modo.
3. Em **Campanhas**, edite textos, importe arquivos, organize a ordem, selecione grupos e configure os horários. Arquivos são copiados para a biblioteca gerenciada. Salvar não inicia uma campanha: abra a prévia e confirme a ativação.
4. Antes de conectar uma conta real, leia [a integração e suas limitações](docs/INTEGRACAO.md). Em **Configurações**, selecione WhatsApp, reconheça o uso **não oficial** e salve. Use Conectar/Reconectar e leia o QR pelo celular, em WhatsApp → Aparelhos conectados → Conectar aparelho.
5. Atualize **Grupos** e declare autorização somente nos destinos em que pode publicar. Grupos simulados não recebem envios reais.
6. Em **Usuários**, vincule os números de controle a usuários ativos. Em Configurações, inclua os números autorizados, com país e DDD. De outro número cadastrado, envie `!mega ajuda` ou `!mega menu` em conversa privada com a conta conectada. A identidade e as permissões do usuário são verificadas em cada comando.

O [guia de uso](docs/GUIA.md) explica usuários, recuperação de senha, alertas e limpeza. O botão **PARAR TODOS OS ENVIOS** está sempre visível e existe também na bandeja; ele interrompe as campanhas que o usuário tem permissão para encerrar. Uma mensagem já submetida pode concluir e não pode ser recolhida. Minimizar mantém o aplicativo funcionando; encerrar interrompe os agendamentos. Sair do login bloqueia o acesso à interface, mas não encerra as campanhas já ativadas.

## Agendamento e proteção contra duplicidade

- O intervalo entre inícios de rodadas é **10 minutos** por padrão. O espaçamento entre envios é configurado separadamente: padrão de **5 segundos**, mínimo local de 3 segundos. Esses valores não garantem ausência de restrições do WhatsApp.
- Uma fila global sequencial atende todas as campanhas. Rodadas demoradas pulam os horários já passados, sem sobreposição ou acúmulo. Repetir envia o conjunto na ordem; alternar envia o próximo item em cada rodada. Os grupos podem ter conteúdo, intervalo e janela próprios.
- Dias, datas, horários e limites diários seguem o fuso do Windows. Início e fim iguais representam 24 horas; janelas noturnas pertencem ao dia em que começam.
- O computador precisa estar ligado, conectado e sem suspensão. Desconexão ou restrição pausa os envios. Reabrir o aplicativo preserva o progresso e exige retomada das campanhas anteriores; rodadas perdidas não são recuperadas.
- Cada tentativa e seu identificador são gravados no SQLite antes da submissão. O aplicativo distingue **confirmado pelo servidor**, **falha** e **incerto**. Confirmação do servidor não significa leitura nem entrega a todos os integrantes.
- Itens incertos não são reenviados automaticamente. Confira a conversa e revise o item no Histórico. A lista de revisões permanece disponível mesmo depois de limpar os históricos; campanhas com envio incerto não podem ser excluídas antes da revisão. Confirmações posteriores podem reconciliar o resultado.
- Cada campanha permite de 1 a 5 tentativas e intervalo de 3 a 3.600 segundos. Só falhas comprovadamente anteriores à submissão permitem nova tentativa. Falhas definitivas encerram a campanha; resultados ambíguos pausam para revisão. Não existem mecanismos para contornar bloqueios ou limites.

## Usuários, alertas e históricos

Os perfis iniciais são **Dono, Administrador, Responsável e Vendedor**. É possível criar perfis, ajustar permissões por usuário e definir campanhas próprias ou todas. As permissões são validadas no serviço de execução, inclusive para comandos do WhatsApp. Senhas usam scrypt com sal individual; o último dono ativo não pode ser removido ou desativado.

Uma ocorrência crítica gera aviso local e alertas privados para donos com telefone, responsáveis e destinatários selecionados na campanha. Sem conexão, os privados permanecem pendentes e mantêm o horário original da falha. O estado confirmado exige ACK ou revisão manual identificada. Um canal HTTPS independente opcional recebe a ocorrência; sua confirmação representa aceitação pelo endpoint, sem comprovar entrega por WhatsApp.

Configurações oferece reconexão com limite de tentativas, retomada automática opcional e som com volume, áudio próprio, repetição, silenciamento e horário silencioso. Notificações e sons dependem de o aplicativo estar em execução e das permissões, volume e estado de mudo do Windows.

**Apagar todos os históricos** permite selecionar categorias, consultar a prévia, exportar os registros e confirmar digitando **APAGAR**. A ação exige permissão específica e grava usuário e horário na auditoria separada. Usuários, grupos, contatos, mídias, configurações, campanhas e registros operacionais contra duplicidade permanecem. Por isso, limpar a visualização não zera necessariamente os contadores operacionais do painel. Diagnóstico oferece filtros, cópia de detalhes, exportação e retenção configurável.

## BUSCAS: ofertas de fornecedores

O módulo começa **desativado**. Em **BUSCAS → Configurações**, selecione os **grupos monitorados**, que fornecem anúncios, e escolha separadamente os **grupos/conversas privadas que aceitam comandos**. Participar de um grupo ou monitorá-lo não autoriza seus integrantes a pesquisar. O dono tem acesso; outros usuários locais ativos precisam de autorização explícita em **BUSCAS → Autorizados** e das permissões correspondentes no perfil. O dono ou uma pessoa autorizada a gerenciar BUSCAS cadastra, desativa ou remove esses acessos. Nomes exibidos não concedem permissão.

O comando inicial é `!busca`, sem `mega`:

```text
!busca 18 pro Max Silver
!busca iPhone 18 Pro Max 256GB Silver
!busca iPhone 15 128GB lacrado
!busca Samsung S24 Ultra 256GB
```

O prefixo é configurável e não diferencia maiúsculas/minúsculas. Usá-lo sozinho retorna orientação curta. Os resultados são até dez ofertas compatíveis, inicialmente do menor para o maior **preço total anunciado à vista**, nas últimas 24 horas e no fuso `America/Sao_Paulo`. Também há validade de três/sete dias ou período personalizado, filtros, sinônimos, bloqueios, limite por usuário e opção de um resultado por fornecedor. Modelo/versão, capacidade, cor, condição, bateria e observações permanecem distintos. Parcelas, entradas, descontos e acessórios não viram preço total; associações ambíguas aguardam revisão fora do ranking.

Por padrão, comandos respondem no **privado do dono com telefone cadastrado**, inclusive quando enviados em grupo autorizado. É possível selecionar solicitante autorizado, responsáveis previamente cadastrados ou conversa de origem; responder na origem exige habilitação explícita. Uma pesquisa no aplicativo mostra resultados localmente e só envia ao usar a ação de entrega. O módulo não contata fornecedores automaticamente.

Cada resultado preserva trecho do anúncio, fornecedor, telefone real quando disponível, grupo e data original. LID não vira número fictício; ausência de telefone aparece como **Número indisponível**. Contato escrito no anúncio e nome salvo/exibido são apresentados separadamente. Encaminhamentos não comprovam o fornecedor original. A oferta mais recente do mesmo fornecedor e combinação substitui a anterior; mudanças de condição continuam separadas. Edições/exclusões dependem dos eventos efetivamente recebidos.

A tela informa início da captura, última sincronização e lacunas. Captura só ocorre com aplicativo conectado; importação anterior aceita somente histórico parcial disponibilizado pela integração. Nenhum período é apresentado como completo. **Apagar histórico de buscas** preserva a base; **Excluir base de ofertas** remove mensagens/anúncios capturados, preservando campanhas, usuários, configurações, auditoria e controles operacionais de entrega. Ambas exigem prévia e **APAGAR**. Consulte [BUSCAS-INTEGRACAO.md](docs/BUSCAS-INTEGRACAO.md) para limitações de comunidades, identidade e histórico.

## Dados, atualização e backup

Os dados ficam em `%APPDATA%\Mega Disparos`, no perfil do Windows. O banco mantém campanhas, progresso, permissões e resultados. A sessão do WhatsApp e as credenciais do canal independente ficam separadas e cifradas por `Electron.safeStorage`/DPAPI no Windows. Não são incluídas em logs ou backups comuns.

Para atualizar, encerre o aplicativo pela bandeja e execute o novo instalador na mesma pasta. A versão 2.1 mantém o diretório de dados, migra o SQLite existente para esquema 5 e cria uma cópia anterior à migração em `backups`. Campanhas, mídias, usuários e configurações anteriores permanecem; o módulo BUSCAS começa desativado. No primeiro cadastro, campanhas antigas sem proprietário passam ao dono cadastrado. Não use a versão antiga para abrir o banco migrado.

O backup portátil `.mega.json` inclui campanhas, grupos, modelos, contatos, destinatários, configurações exportáveis e mídias; exclui usuários, hashes de senha, códigos de recuperação, sessão, credenciais, áudio personalizado, históricos e **dados/configurações/autorizações de BUSCAS**. A base capturada fica no banco local e não é transportada por esse backup. Proteja o arquivo porque contém conteúdos e números de telefone. Restaurar cria um backup automático anterior, preserva usuários, permissões e BUSCAS locais, deixa as campanhas desativadas e volta à simulação. Credenciais e sessões não são transferidas para outro computador. Backup/restauração global exige as permissões correspondentes e acesso a todas as campanhas. A cópia SQLite de migração contém dados locais e deve permanecer protegida no perfil do Windows.

Arquivos de campanha: até **64 MiB por arquivo**, com JPG/JPEG/PNG/WebP, MP4/MOV e documentos PDF/DOC/DOCX/XLS/XLSX/PPTX/TXT/CSV/ZIP. Backup: até 512 MiB de mídias. Textos: 16.000 caracteres; legendas: 1.000; sequência: até 100 itens. São limites locais, sujeitos também às restrições do serviço e à compatibilidade dos codecs. Não há conversão automática de vídeos.

## Arquitetura e desenvolvimento

Electron fornece janela, bandeja, atalhos, notificações e inicialização no Windows. Um **worker dedicado** executa banco, autenticação, filas, interpretação das ofertas e processamento de mídias; o processo principal cuida dos recursos nativos e da proteção de credenciais. A interface isolada não acessa Node.js. SQLite nativo usa WAL e transações duráveis, com consultas indexadas e paginação. BUSCAS usa captura por eventos e fila persistente limitada; respostas compartilham a coordenação das submissões de campanhas. Importação e backup processam arquivos em blocos. O bloqueio de instância e a fila única impedem processamento simultâneo da mesma fila.

```text
src/main.cjs             janela, bandeja, IPC e recursos nativos
src/backend/             worker e serviço de aplicação autorizado
src/preload.cjs           ponte restrita para a interface
src/core/                SQLite, autenticação, mídias, fila, comandos e alertas
src/adapters/            WhatsApp não oficial e integração simulada
src/ui/                  interface em português e reprodução de alertas
test/                    testes com dados e transporte simulados
scripts/                 compilação e validação de desktop/interface
docs/                    integração, guia e validação
```

Para desenvolver/recompilar: **Node.js 24+** e npm; execute `npm ci`, `npm test`, `npm run check`, `npm start` e `npm run dist:win`. Dependências estão fixadas no `package-lock.json`. Baileys **7.0.0-rc14** é uma versão candidata e exige manutenção quando o protocolo muda. O instalador NSIS tem script próprio e pode ser compilado sem Wine.

Consulte [VALIDACAO.md](docs/VALIDACAO.md) e [as alterações da versão 2](docs/ALTERACOES-2.0.0.md). Nenhuma conta real foi conectada nem houve teste em Windows físico neste ambiente. Envios reais devem ser validados somente no grupo indicado pelo usuário.

Licença do aplicativo: MIT. Dependências conservam suas próprias licenças. As notas de [1.0.1](docs/CORRECOES-1.0.1.md) e [1.0.2](docs/DISTRIBUICAO-1.0.2.md) permanecem como histórico das versões anteriores.
