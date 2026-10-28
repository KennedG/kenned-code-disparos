# Correções da versão 1.0.1

Revisão de 1 de outubro de 2026. Esta versão substitui o instalador 1.0.0 e preserva os dados locais ao atualizar.

- Rodadas normais não invalidam prévias nem edições: a versão da configuração passa a ser independente do andamento da fila. Alterações em execução aguardam o envio corrente terminar e preservam o índice de alternância. Uma parada durante a edição não reativa a campanha.
- Toda tentativa verifica novamente horários, datas, conexão e armazenamento. Falta de espaço ou falha de gravação bloqueia novas chamadas de envio, inclusive quando a gravação falhou fora do agendador. Pausa e parada abortam a fila antes de depender do banco.
- Envios sem resposta ficam incertos após 90 segundos e não são repetidos. Download e resposta de controle também têm prazo; arquivos parciais são descartados. Pausar e parar por WhatsApp passam à frente de operações lentas, mantendo a validação do remetente e a proteção contra repetição.
- Legendas começando com `!mega` permanecem conteúdo da mídia; somente mensagens de texto de controle executam comandos. Sessões de edição mantêm a verificação da configuração antes de salvar.
- Reconectar recria o transporte. Logout remove a sessão inválida; a interface permite remover uma sessão mesmo quando estiver desconectada.
- Backups validam campanhas, grupos, administradores e configurações antes de substituir dados. Arquivos recebidos com extensão desconhecida recebem a extensão correspondente ao formato suportado; backups antigos desses arquivos também podem ser restaurados. Restauração não volta a criar o exemplo inicial sobre dados restaurados.
- Restauração, exclusão e troca de integração aguardam o resultado do envio em andamento. Resultados incertos antigos continuam visíveis para revisão, mesmo após mais de 500 registros recentes.
- O painel conta os destinos configurados, incluindo os 15 grupos do exemplo desativado. Configurações preservam campos não salvos e a preferência de perguntar ao fechar.
- O instalador usa uma pasta dedicada e inclui um manifesto dos próprios arquivos. A desinstalação preserva arquivos alheios e os dados em AppData.

Validação: 96 testes automatizados passaram, além da interface Electron aberta com dados simulados. Não houve envio real. Instalação em Windows físico e conexão com uma conta real permanecem sem validação neste ambiente; veja [VALIDACAO.md](VALIDACAO.md).

Para atualizar, encerre Mega Disparos pelo menu da bandeja e execute `Mega-Disparos-Setup-1.0.1-x64.exe` na mesma pasta da instalação anterior. A integração continua sendo WhatsApp Web via Baileys, **não oficial**, com as limitações descritas em [INTEGRACAO.md](INTEGRACAO.md).
