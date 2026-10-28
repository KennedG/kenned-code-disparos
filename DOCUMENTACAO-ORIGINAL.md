# Kenned Code Disparos 2.3.3

Atualização baseada exclusivamente no código verificado da **2.3.0**, sem módulos de vendas, caixa ou financeiro e sem nova comparação automática de ofertas equivalentes. Preserva campanhas, contatos, grupos, BUSCAS, modelos, mídias, lembretes, usuários, permissões, responsáveis, configurações e credenciais locais.

A **2.3.2** integra teste gratuito de 72 horas e ativação automática mensal/anual por um serviço HTTPS com banco persistente. O primeiro registro do teste exige internet, não exige chave nem aprovação. O aplicativo verifica comprovantes assinados e a identidade protegida do dispositivo; dados do usuário permanecem preservados ao vencer. Consulte [licenciamento e recuperação](docs/LICENCIAMENTO-2.3.2.md) e [validação específica](docs/VALIDACAO-LICENCA-2.3.2.md). Chaves de distribuição e credenciais administrativas ficam fora do código-fonte e do instalador.

A 2.3.1 acrescenta Excel verdadeiro de selecionados ou de todos os resultados filtrados entre páginas, envio manual de listas com prévia e comandos privados `--excel`/`--ambos`. Corrige defeitos reproduzíveis de recuperação de mensagens, diagnóstico, autorização e submissão; aceitação pela integração e entrega permanecem estados distintos.

**Candidata à validação real:** testes automatizados, interface Electron e transporte controlado não comprovam recebimento no WhatsApp. Neste ambiente não havia conta da loja conectada nem número particular de teste identificado. Instalação e notificações físicas no Windows também dependem desse equipamento. Consulte [a validação da atualização](docs/VALIDACAO-2.3.1.md).

Execute **Kenned-Code-Disparos-Setup-2.3.3-x64.exe**. O runtime está incluído; o uso diário dispensa Node.js e terminal. Leia antes [atualização e recuperação](docs/ATUALIZACAO-2.3.1.md), que orienta a cópia privada integral do perfil existente. Comandos e limites estão em [Excel pelo WhatsApp](docs/COMANDOS-EXCEL-2.3.1.md). O instalador não tem certificado de assinatura de código.

## Primeiros passos

1. No primeiro acesso, cadastre o **Dono**, use uma senha de pelo menos 12 caracteres e guarde os oito códigos de recuperação mostrados uma única vez. Depois disso, novos usuários são cadastrados por um administrador autorizado.
2. Uma instalação nova começa em **SIMULAÇÃO — DADOS FICTÍCIOS**, com 15 grupos fictícios e uma campanha **desativada**, a cada 10 minutos, das 08:00 às 18:00, todos os dias. Nenhuma conta real é conectada nesse modo.
3. Em **Campanhas**, edite textos, importe arquivos, organize a ordem, selecione grupos e configure os horários. Arquivos são copiados para a biblioteca gerenciada. Salvar não inicia uma campanha: abra a prévia e confirme a ativação.
4. Antes de conectar uma conta real, leia [a integração e suas limitações](docs/INTEGRACAO.md). Em **Configurações**, selecione WhatsApp, reconheça o uso **não oficial** e salve. Use Conectar/Reconectar e leia o QR pelo celular, em WhatsApp → Aparelhos conectados → Conectar aparelho.
5. Atualize **Grupos** e declare autorização somente nos destinos em que pode publicar. No modo real, seletores e resultados mostram somente registros reais. Sem grupos carregados, use sincronizar; não há preenchimento de demonstração. A simulação usa um armazenamento lógico separado e nunca submete mensagens à rede WhatsApp.
6. Em **Usuários**, vincule os números de controle a usuários ativos. Em Configurações, inclua os números autorizados, com país e DDD. De outro número cadastrado, envie `!mega ajuda` ou `!mega menu` em conversa privada com a conta conectada. A identidade e as permissões do usuário são verificadas em cada comando.

O [guia de uso](docs/GUIA.md) explica usuários, recuperação de senha, alertas e limpeza. O botão **PARAR TODOS OS ENVIOS** está sempre visível e existe também na bandeja. A ação global exige a permissão `automation.control`: pausa campanhas e lembretes, cancela pendências automáticas de campanhas, buscas e alertas, e bloqueia novas entradas até **Retomar sistema** ou `!mega retomar sistema`. Esse bloqueio persiste após reiniciar e é separado por modo real/simulação. Retomar libera as filas; campanhas e lembretes pausados exigem ativação individual. Os comandos administrativos continuam disponíveis. Uma mensagem já submetida pode concluir e não pode ser recolhida. Minimizar mantém o aplicativo funcionando; encerrar interrompe os agendamentos. Sair do login bloqueia o acesso à interface, mas não encerra as campanhas já ativadas.

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

Uma ocorrência crítica gera aviso local e alertas privados para donos com telefone, responsáveis e destinatários selecionados na campanha. Sem conexão, os privados permanecem pendentes e mantêm o horário original da falha, exceto quando a interrupção global bloqueou/cancelou os envios. **Enviar alerta de teste** usa o mesmo fluxo dos avisos reais. A interface distingue pendência, aceitação confirmada pelo servidor, entrega quando há recibo, falha e resultado incerto. Há limite de 1–5 tentativas e intervalo de 3–3.600 segundos para falhas temporárias comprovadamente anteriores à submissão. Um canal HTTPS independente opcional recebe a ocorrência; sua confirmação representa aceitação pelo endpoint, sem comprovar entrega por WhatsApp.

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

O dono pode enviar o comando manualmente pela própria conta conectada, incluindo a conversa consigo mesmo quando habilitada. A identidade vem da sessão autenticada e precisa estar vinculada ao dono; mensagens automáticas do aplicativo não geram novos comandos. Cada identificador de comando é processado uma vez. O prefixo é configurável e não diferencia maiúsculas/minúsculas. Usá-lo sozinho retorna orientação curta. Os resultados são até dez ofertas compatíveis, inicialmente do menor para o maior **preço total anunciado à vista**, nas últimas **duas horas**, segundo a data original da mensagem, no fuso `America/Sao_Paulo`. A idade máxima pode usar minutos ou horas ou ser desativada; limites personalizados e retenção continuam aplicáveis. Edições não renovam a idade da oferta. Há ordenação por menor preço, maior preço ou publicação mais recente e filtros persistentes por modelo, armazenamento, condição, fornecedor e grupo, além de sinônimos, bloqueios, limite por usuário e opção de um resultado por fornecedor. Modelo/versão, capacidade, cor, condição, bateria e observações permanecem distintos. Parcelas, entradas, descontos e acessórios não viram preço total; preços ausentes ou associações ambíguas ficam fora do ranking confirmado.

**Comandos recebidos em conversa privada respondem somente ao solicitante autorizado, na mesma conversa privada**, independentemente dos destinatários gerais configurados. A autorização usa o remetente autenticado e o vínculo a usuário ativo. Para comandos de grupos e entregas iniciadas no aplicativo, o padrão continua sendo privado do dono; há opções de solicitante, responsáveis cadastrados ou origem explicitamente habilitada. Uma pesquisa no aplicativo mostra resultados localmente e só envia ao usar a ação de entrega. Use **Testar envio** para conferir cada destinatário; a tela distingue fila pendente, confirmação do servidor, confirmação de entrega quando disponível, falha e incerteza. Uma falha não muda silenciosamente o destino. O módulo não contata fornecedores automaticamente.

Em uma instalação nova, comandos privados estão habilitados, mas ainda exigem autorização explícita da pessoa; lista de conversas privadas vazia permite os privados dessas pessoas autorizadas. **Uma opção anteriormente salva como desativada é preservada**: habilite-a em BUSCAS se o aplicativo indicar bloqueio do privado. Todas as listas de grupos de BUSCAS têm selecionar/desmarcar os resultados exibidos e contador; grupos selecionados fora do filtro são preservados. Grupos fictícios aparecem somente no modo simulado.

Cada resultado preserva trecho do anúncio, fornecedor, telefone real quando disponível, grupo e data original. LID não vira número fictício; ausência de telefone aparece como **Número indisponível**. Contato escrito no anúncio e nome salvo/exibido são apresentados separadamente. Encaminhamentos não comprovam o fornecedor original. A oferta mais recente do mesmo fornecedor e combinação substitui a anterior; mudanças de condição continuam separadas. Edições/exclusões dependem dos eventos efetivamente recebidos.

A tela informa início da captura, última sincronização e lacunas. Captura só ocorre com aplicativo conectado; importação anterior aceita somente histórico parcial disponibilizado pela integração. Nenhum período é apresentado como completo. **Apagar histórico de buscas** preserva a base; **Excluir base de ofertas** remove mensagens/anúncios capturados, preservando campanhas, usuários, configurações, auditoria e controles operacionais de entrega. Ambas exigem prévia e **APAGAR**. Consulte [BUSCAS-INTEGRACAO.md](docs/BUSCAS-INTEGRACAO.md) para limitações de comunidades, identidade e histórico.

## Modelos, mídias, lembretes e contatos

**Biblioteca** permite criar, nomear, editar, duplicar, excluir e usar modelos de texto/mídias em campanhas. O editor preserva texto, formatação, legendas e ordem; salvar verifica a gravação persistente. Mídias são copiadas para a pasta gerenciada. Exclusão individual ou múltipla exige confirmação; vínculos a campanhas, configurações de grupos, modelos ou envios operacionais pendentes/incertos impedem a exclusão e mostram onde o arquivo está em uso.

**LEMBRETES** oferece título, descrição, horário/fuso de Brasília, repetição diária, dias específicos ou data única, destinatário autorizado, ativação, pausa, edição, exclusão e teste. Próximo aviso e último resultado permanecem no banco local. Um identificador durável por ocorrência evita duplicidade após reinício. Escolha ignorar vencidos ou enviar somente o aviso mais recente uma vez dentro da tolerância configurada; não há envio de todos os horários perdidos. Os avisos precisam do aplicativo e conexão ativos; incertezas exigem revisão.

**CONTATOS** cria uma pendência para o primeiro contato privado de um número ainda não cadastrado e avisa o dono localmente, sem repetir enquanto a pendência estiver aberta. Participantes de grupos não são cadastrados como clientes. Edite o nome e selecione **Cliente Nerópolis** ou **Lojista Camelódromo** antes de salvar. O cadastro é local no sistema; Baileys não oferece a gravação na agenda vinculada. Identificadores internos sem telefone confiável não geram números fictícios.

## Dados, atualização e backup

O nome exibido passa a ser **Kenned Code Disparos**. Os dados continuam em `%APPDATA%\Mega Disparos`, no perfil do Windows, por compatibilidade com a instalação anterior; o aplicativo seleciona esse diretório antes do bloqueio de instância. O identificador do Windows, as chaves de atualização e a proteção DPAPI permanecem estáveis. O banco mantém campanhas, progresso, permissões e resultados. A sessão do WhatsApp e as credenciais do canal independente ficam separadas e cifradas por `Electron.safeStorage`/DPAPI no Windows. Não são incluídas em logs ou backups comuns.

Para atualizar, encerre o aplicativo pela bandeja e execute o novo instalador na mesma pasta. A versão 2.3.2 mantém o diretório de dados e o **esquema 7** da base 2.3.0. Antes de abrir um banco existente nesta atualização, cria e verifica uma cópia em `backups`. Campanhas, mídias, usuários e configurações anteriores permanecem. O instalador aceita a pasta dedicada antiga ou a nova e substitui somente atalhos conhecidos; o executável antigo só é removido quando estiver no manifesto de propriedade do pacote anterior. BUSCAS começa desativado apenas quando não houver configuração anterior. No primeiro cadastro, campanhas antigas sem proprietário passam ao dono cadastrado. Não use a versão antiga para abrir o banco migrado.

O backup portátil `.mega.json` inclui campanhas, grupos, modelos, contatos, destinatários, **configurações dos lembretes**, configurações exportáveis e mídias; exclui usuários, hashes de senha, códigos de recuperação, sessão, credenciais, áudio personalizado, históricos, ledgers de envio e **dados/configurações/autorizações de BUSCAS**. A base capturada fica no banco local e não é transportada por esse backup. Proteja o arquivo porque contém conteúdos e números de telefone. Restaurar cria um backup automático anterior, preserva usuários, permissões e BUSCAS locais, deixa campanhas e lembretes restaurados desativados e conserva o modo de origem informado pelo backup. Destinatário de lembrete ausente no computador exige revisão antes da ativação. Um backup antigo sem o campo de lembretes preserva os lembretes locais. Em backups antigos sem modo, somente grupos explicitamente marcados como simulação permitem inferir o modo simulado; nos demais casos, o modo é real. A base do outro modo é preservada, sem converter registros reais em simulação ou dados fictícios em reais. Credenciais e sessões não são transferidas para outro computador. Backup/restauração global exige as permissões correspondentes e acesso a todas as campanhas. A cópia SQLite de migração contém dados locais e deve permanecer protegida no perfil do Windows.

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

Consulte [VALIDACAO-2.3.0.md](docs/VALIDACAO-2.3.0.md), [as correções 2.3.0](docs/CORRECOES-2.3.0.md), [as correções 2.2.0](docs/CORRECOES-2.2.0.md) e [as alterações da versão 2](docs/ALTERACOES-2.0.0.md). Nenhuma conta real foi conectada nem houve teste em Windows físico neste ambiente. A validação de recebimento de buscas, alertas e lembretes no WhatsApp real está pendente e deve usar somente destinatários de teste autorizados, sem clientes ou grupos de produção.

Licença do aplicativo: MIT. Dependências conservam suas próprias licenças. As notas de [1.0.1](docs/CORRECOES-1.0.1.md) e [1.0.2](docs/DISTRIBUICAO-1.0.2.md) permanecem como histórico das versões anteriores.

## Correção de compatibilidade 2.3.3

A abertura do esquema 8 conhecido agora verifica a estrutura comum, cria backup consistente e conserva a versão e todos os registros adicionais. A primeira abertura mantém as automações pausadas para revisão. Bancos novos permanecem no esquema 7. Veja [correção e recuperação](docs/CORRECAO-BANCO-2.3.3.md).
