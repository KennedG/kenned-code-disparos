# Validação da versão 2.1.0

Ambiente: Linux x64, Node.js 24.19.0, Electron 44.5.1 e electron-builder 26.15.3. O destino do pacote é Windows 10/11 x64 com runtime incluído e instalador NSIS em português. Dependências estão fixadas no `package-lock.json`.

**Resultado consolidado desta versão: 292 casos automatizados aprovados, zero falhas** — 284 testes do núcleo, três do worker real e cinco fluxos da fachada desktop. As verificações de sintaxe e dois fluxos completos da interface Electron também passaram. Registro: `TESTES-2.1.0.txt`.

## Testes específicos de BUSCAS

Os cenários abaixo utilizam mensagens, contas, grupos e transporte fictícios. Os eventos do adaptador foram conferidos com o código-fonte da versão instalada Baileys 7.0.0-rc14 e com os arquivos públicos do mesmo release. Não houve conexão nem envio para o WhatsApp real.

| Suíte | Resultado validado | Cobertura principal |
| --- | --- | --- |
| `test/search-parser.test.cjs` | 33 testes passaram | Listas, preço por cor/capacidade, `18 pro Max Silver`, ProMax e apelidos, versões distintas, condições/bateria/garantia, parcelas/entradas/acessórios excluídos, ambiguidades, lote e “a partir de”, oferta mais recente, indisponibilidade, encaminhamentos e ranking de até dez. |
| `test/search-adapter.test.cjs` | 13 testes passaram | Captura desativada inicialmente, monitoramento separado dos comandos, nomes reais, telefone indisponível, LID/PN, duplicidade, histórico parcial em lotes, recuperação do telefone sem comandos, edição/exclusão, comunidades reais, ACK, destino explícito e desconexão. |
| `test/search-storage.test.cjs` | 15 testes passaram | Migração de esquema 4 para 5 preservando campanhas, persistência/indexação/paginação, atualização idempotente, tombstone, última oferta antes dos filtros, um resultado por fornecedor, limpeza separada, ledgers e auditoria preservados, retenção e privacidade dos backups portáteis. |
| `test/search-backend.test.cjs` | 8 testes passaram | Preservação de configurações, autorização explícita e permissão local, recusa de identidade forjada, senha temporária/usuário desativado, consultas e prefixos, lista de produtos, edição/exclusão, limpeza e resposta privada pendente após desconexão. |

`test/search-service.test.cjs` exercita diretamente o serviço de captura e busca: comando ancorado, prefixo sem produto, locais bloqueados, autorização, limite por usuário, destinatário privado, atualização e desconexão. **18 testes passaram**, incluindo revalidação da fila de comandos, bloqueio de encaminhamentos, revisão de produtos ambíguos, período no fuso escolhido, filtros de fornecedor/garantia e estados reais de entrega no histórico.

A verificação de entrega deve executar `npm test`, `npm run check` e o teste de interface Electron. O arquivo [resultados-testes.txt](resultados-testes.txt) deve corresponder à execução consolidada entregue; resultados da versão anterior não substituem o teste da versão atual.

## Base anterior e regressões preservadas

A versão 2.0.0 anterior teve **199 casos e zero falhas: 191 testes do núcleo, 3 testes do worker real e 5 fluxos do desktop**, além de verificações de sintaxe. Esse resultado é uma referência histórica, não o total da versão 2.1.0.

Os testes do núcleo cobrem:

- Agendamento contado entre inícios, quinze destinos, ordem texto/mídia, rodadas longas sem sobreposição/acúmulo, fila sequencial, pausa/parada, janelas noturnas, dias/datas e limites diários.
- SQLite durável, migração do banco anterior, progresso por grupo, índices/paginação, falha de armazenamento, confirmação posterior e recuperação sem repetir itens confirmados ou incertos.
- Primeiro dono, login, hash seguro, bloqueio de tentativas, troca de senha temporária, recuperação de uso único, usuário desativado, perfis/permissões e proteção do último dono.
- Autorização dos comandos por identidade e usuário ativo, permissões por campanha, rejeição de grupos/encaminhamentos/fromMe/histórico/replay/LID não verificável e revalidação na confirmação.
- Limpeza por categoria, manutenção do ledger/auditoria/dados cadastrados, revisões disponíveis após a limpeza, retenção e exportação paginada com revalidação de acesso.
- Falha definitiva e resultado incerto, tentativas limitadas, alerta privado único por ocorrência, pendência desconectada, horário original, ACK posterior e incerteza após reinício.
- Falta de internet/desconexão simuladas, reconexão limitada, tentativas zero, ausência de handshakes duplicados e retomada opcional sem reverter pausa manual.
- Controle de som, volume zero, repetição, deduplicação, fila, silenciamento, horário silencioso e encerramento.
- Cópia gerenciada, checksums, limites e caminhos; backup/restauração em fluxo, corrupção/truncamento e limpeza de arquivos parciais. Um teste processa mídia de 24 MiB sob heap de 48 MiB para verificar que a restauração não depende de carregar o base64 completo em memória.

Todos esses cenários usam dados fictícios, biblioteca/eventos de transporte simulados ou recursos nativos substituídos por um ambiente de teste. Nenhuma conta WhatsApp real participa da suíte.

Os três testes do worker usam thread real e RPC: verificam persistência/login na reabertura, recusa de ações internas pela API pública, aviso de desconexão mesmo sem login, registro de confirmação nativa explícita, silenciamento e resposta do processo host enquanto o worker executa trabalho de CPU. A saída abrupta do worker rejeita requisições pendentes.

Os cinco fluxos do desktop exercitam o processo principal com recursos nativos substituídos: instância única, origem IPC e autorização da bandeja; retorno de notificações sem assumir exibição a partir da solicitação; eventos de rede/suspensão/encerramento; manifesto do instalador; e código do renderizador de áudio com ganho e volume para som padrão/personalizado. Esses testes não emitem nem medem áudio físico no Windows.

## Interface Electron real da versão 2.1.0

O fluxo de regressão das campanhas foi executado novamente na versão 2.1.0, aberto em desktop virtual Linux, com o serviço e o worker reais, sem backend fictício da interface. O fluxo passou por cadastro do dono, exibição dos códigos de recuperação, navegação nas onze seções, imagem da biblioteca carregada pelo protocolo local restrito, criação desativada, organização de textos, seleção de grupo, prévia e ativação com dois envios confirmados **em simulação**, além da parada global.

Também foram verificados preservação de configurações em edição, gravação do tema e volume 37%, teste de som com volume zero, comando autorizado e rejeição de outro número, confirmação **APAGAR**, histórico visível vazio com ledger/contagens preservados e auditoria da limpeza. Cadastro de vendedor, troca obrigatória da senha, ocultação de campanhas alheias, recusa de limpeza no backend, logout/login do dono e paginação completaram o fluxo.

O teste de volume zero comprova o silenciamento lógico do recurso; não mede volume audível em alto-falante ou mixer de um Windows físico. Screenshots `painel.png` e `painel-claro.png` são capturas da interface, sem códigos de recuperação.

`scripts/smoke-searches-ui.cjs` passou com o processo principal, worker, banco e interface reais: seis abas BUSCAS, módulo inicialmente desativado, grupos monitorados separados dos locais de comandos, prefixo atualizado e exemplo correspondente, edição preservada, captura simulada, ranking sem parcelas/modelos incompatíveis, mensagem original, comando vazio, resposta privada confirmada para o dono, ofertas em revisão, histórico e limpezas separadas APAGAR. Campanhas/grupos foram preservados e o logout bloqueou o backend. Screenshot `buscas-resultados.png`.

`test/submission-queue.test.cjs` acrescenta seis regressões da fila compartilhada: FIFO, ausência de sobreposição entre campanhas, alertas e pesquisas, liberação após erro e encerramento aguardando a submissão iniciada sem repetir a pendente.

## Desempenho e verificações de distribuição

Um ensaio da base anterior com 15.000 jobs, 1.000 rodadas e 15 grupos mediu média de **3,376 ms** para um conjunto de quatro consultas indexadas — página de cinquenta registros, métricas, progresso de grupo e limites diários — em cem repetições. Trata-se de uma medição em Linux/Node.js 24.19.0 neste ambiente, sem rede e sem prometer o mesmo desempenho em qualquer computador Windows.

O projeto inclui verificação de sintaxe, testes do host desktop/worker e script de compilação Windows. O instalador usa manifesto de propriedade para remover somente arquivos do pacote e preservar AppData e arquivos desconhecidos; cria atalhos e oferece atalho opcional na área de trabalho. Integridade do executável e correspondência do código empacotado com o fonte devem ser conferidas na entrega do artefato, separadamente da suíte funcional.

## Limites da validação

**Não houve máquina Windows física, conta WhatsApp conectada ou grupo real de teste indicado.** Portanto, esta execução não comprova instalação/desinstalação no Windows, inicialização real com o sistema, notificação física com a janela na bandeja, permissões do centro de notificações, volume audível/mudo do Windows, leitura real do QR ou entrega de mensagens privadas/grupos contra o serviço.

Recursos nativos foram implementados usando as APIs do Electron/Windows, mas exigem essa validação posterior. O endpoint HTTPS opcional exige configuração externa; sua aceitação não é prova de entrega WhatsApp. A integração é **Baileys não oficial**, em versão candidata, e está documentada em [INTEGRACAO.md](INTEGRACAO.md) e [BUSCAS-INTEGRACAO.md](BUSCAS-INTEGRACAO.md). BUSCAS não promete histórico completo, recebimento retroativo de todas as edições/exclusões, acesso a grupos não participantes ou número telefônico para todo LID. A interpretação usa gramática limitada e manda associações desconhecidas/ambíguas para revisão; ela não confirma estoque nem autenticidade do fornecedor. Testes reais de envio devem ocorrer exclusivamente no grupo indicado pelo usuário.

O fluxo anterior da versão 2.0.0 também passou abrindo o `app.asar` empacotado para Windows com o runtime Electron Linux. Isso verifica a inclusão e execução do worker, banco nativo, pré-carregamento, módulos e telas no arquivo do pacote; não substitui executar o binário Windows no Windows. A importação do Baileys instalado também foi verificada sem conectar uma conta.
