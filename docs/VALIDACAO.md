# Validação da versão 2.0.0

Ambiente: Linux x64, Node.js 24.19.0, Electron 44.5.1 e electron-builder 26.15.3. O destino do pacote é Windows 10/11 x64 com runtime incluído e instalador NSIS em português. Dependências estão fixadas no `package-lock.json`.

## Resultados automatizados

A execução final passou com **199 casos e zero falhas: 191 testes do núcleo, 3 testes do worker real e 5 fluxos do desktop**. As verificações de sintaxe também passaram. A saída está em [resultados-testes.txt](resultados-testes.txt); ela não constitui teste em Windows físico.

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

## Interface Electron real

O aplicativo Electron foi aberto em desktop virtual Linux, com o serviço e o worker reais, sem backend fictício da interface. O fluxo passou por cadastro do dono, exibição dos códigos de recuperação, navegação nas onze seções, imagem da biblioteca carregada pelo protocolo local restrito, criação desativada, organização de textos, seleção de grupo, prévia e ativação com dois envios confirmados **em simulação**, além da parada global.

Também foram verificados preservação de configurações em edição, gravação do tema e volume 37%, teste de som com volume zero, comando autorizado e rejeição de outro número, confirmação **APAGAR**, histórico visível vazio com ledger/contagens preservados e auditoria da limpeza. Cadastro de vendedor, troca obrigatória da senha, ocultação de campanhas alheias, recusa de limpeza no backend, logout/login do dono e paginação completaram o fluxo.

O teste de volume zero comprova o silenciamento lógico do recurso; não mede volume audível em alto-falante ou mixer de um Windows físico. Screenshots `painel.png` e `painel-claro.png` são capturas da interface, sem códigos de recuperação.

## Desempenho e verificações de distribuição

Um ensaio local com 15.000 jobs, 1.000 rodadas e 15 grupos mediu média de **3,376 ms** para um conjunto de quatro consultas indexadas — página de cinquenta registros, métricas, progresso de grupo e limites diários — em cem repetições. Trata-se de uma medição em Linux/Node.js 24.19.0 neste ambiente, sem rede e sem prometer o mesmo desempenho em qualquer computador Windows.

O projeto inclui verificação de sintaxe, testes do host desktop/worker e script de compilação Windows. O instalador usa manifesto de propriedade para remover somente arquivos do pacote e preservar AppData e arquivos desconhecidos; cria atalhos e oferece atalho opcional na área de trabalho. Integridade do executável e correspondência do código empacotado com o fonte devem ser conferidas na entrega do artefato, separadamente da suíte funcional.

## Limites da validação

**Não houve máquina Windows física, conta WhatsApp conectada ou grupo real de teste indicado.** Portanto, esta execução não comprova instalação/desinstalação no Windows, inicialização real com o sistema, notificação física com a janela na bandeja, permissões do centro de notificações, volume audível/mudo do Windows, leitura real do QR ou entrega de mensagens privadas/grupos contra o serviço.

Recursos nativos foram implementados usando as APIs do Electron/Windows, mas exigem essa validação posterior. O endpoint HTTPS opcional exige configuração externa; sua aceitação não é prova de entrega WhatsApp. A integração é **Baileys não oficial**, em versão candidata, e está documentada em [INTEGRACAO.md](INTEGRACAO.md). Testes reais de envio devem ocorrer exclusivamente no grupo indicado pelo usuário.

O mesmo fluxo completo de interface também passou abrindo o `app.asar` empacotado para Windows com o runtime Electron Linux. Isso verifica a inclusão e execução do worker, banco nativo, pré-carregamento, módulos e telas no arquivo do pacote; não substitui executar o binário Windows no Windows. A importação do Baileys instalado também foi verificada sem conectar uma conta.
