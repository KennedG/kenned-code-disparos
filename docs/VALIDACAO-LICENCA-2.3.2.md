# Validação do licenciamento — 2.3.2

Este documento distingue implementação, teste automatizado, teste contra serviço publicado e execução física no Windows. Resultados só devem ser marcados como aprovados depois de executar o cenário correspondente. O licenciamento não comprova recebimento de mensagens pelo WhatsApp.

**Política atual reformulado-r1:** após vencimento confirmado, somente licença e contato com o desenvolvedor ficam disponíveis. Os resultados históricos descritos abaixo são da implementação anterior do mecanismo; não comprovam por si sós o bloqueio total de consulta/exportação introduzido nesta revisão. A validação dessa regra consta no relatório final da entrega reformulada.

## Matriz de riscos e verificações

| Cenário | Evidência necessária |
|---|---|
| Primeiro registro, sem chave | Horário do servidor e vencimento exatamente 72 horas depois; nenhum pedido de aprovação. |
| Reinstalação / perfil local apagado | Mesmo equipamento retorna o teste original ou bloqueia identidade inconsistente; não recebe mais 72 horas. |
| Expiração | Vencimento confirmado bloqueia envios, automações, consulta, exportação e ferramentas; somente licença e contato com desenvolvedor ficam disponíveis. Dados permanecem armazenados e TV mostra estado neutro. |
| Licença mensal/anual | Plano do cadastro oficial, começo na primeira ativação e vencimento de calendário; comprovante verificado. |
| Mês curto / ano bissexto | Resultados conhecidos para 31/01, 31/03 e 29/02, com calendário de Brasília, horário preservado e último dia válido. |
| Concorrência | Dois dispositivos ou dois pedidos da mesma chave não consomem nem acrescentam o prazo duas vezes. |
| Repetição / idempotência | Solicitação repetida e repetição da chave mantêm a mesma concessão, inclusive após reiniciar. |
| Renovação | Antecipada acrescenta ao vencimento; atrasada começa no horário do servidor; teste não encurta o primeiro período pago. |
| Assinatura e vínculo | Token alterado, algoritmo errado, emissor/audiência errados ou dispositivo diferente são recusados. |
| Revogação / resposta negativa | Não é tratada como simples falta de internet nem reaproveita uma licença recusada. |
| Falha de internet | Cache válido funciona até no máximo 72 horas e nunca após o vencimento; retorno online revalida. |
| Relógio | Regressão local relevante, tolerância artificialmente estendida e cópia antiga do estado não autorizam mais tempo. |
| Expiração e renovação | Campanhas ficam pausadas e precisam de decisão explícita para voltar; nenhuma retomada automática. |
| Permissões | Licença não remove autorização de BUSCAS, controle administrativo ou acesso aos dados. |
| Segredos no pacote | Ausência das 120 chaves, chaves privadas e credenciais administrativas no ASAR, instalador e fonte do aplicativo. |
| Lote administrativo | Exatamente 100 mensais e 20 anuais únicas, cadastradas e ainda não ativadas; chaves de teste separadas. |
| Drive | Pastas privadas e planilha verificadas; distribuição não altera ativação oficial. |
| Windows empacotado | Versão do pacote, interface real, persistência, identidade protegida, expiração e recuperação. |

## Limites de interpretação

Um serviço local controlado permite verificar protocolo, cálculos, atomicidade e recusas, mas não prova disponibilidade pública. Uma chamada HTTPS bem-sucedida ao serviço publicado prova aquela operação e aquele instante; não promete disponibilidade permanente. Execute a instalação e a identidade DPAPI em um Windows 10/11 real para concluir essa parte.

Testes de licenciamento devem usar chaves de teste separadas. As 100 chaves mensais e 20 anuais entregues devem permanecer sem ativação. Não registre suas chaves completas em logs ou relatórios públicos.

## Testes automatizados executados nesta revisão

- **34 testes do serviço passaram**, executando o código do Worker com SQLite persistente na duração de cada cenário e uma camada controlada compatível com as operações D1. Há também requisições HTTP locais reais. Foram verificados teste de 72 horas, perda da identidade local, calendários curtos e bissextos, fronteira UTC/Brasília, ativação concorrente, renovações, idempotência, assinatura, revogação, limites, importação de 120 chaves fictícias de teste e falha transacional de gravação. O resultado não equivale à validação de um banco D1 publicado.
- **12 testes independentes de segurança passaram**, com criptografia real e HTTP controlado: alteração do comprovante, chave de assinatura errada, dispositivo diferente, algoritmo/audiência/plano incorretos, prazo offline acima de 72 horas, precisão do vencimento, retomada offline sem renovar a tolerância, revogação persistente, comprovantes antigos, reprodução de desafio antigo, relógio regressivo/congelado, ausência de segredos na resposta pública, salvamento interrompido dos dois pontos de persistência e isolamento da exceção administrativa. Um dos cenários usa o backend completo com SQLite e adaptador simulado; não realiza envio WhatsApp.
- Foram conferidos independentemente cinco exemplos conhecidos de cálculo de calendário, incluindo instantes que ainda são 31 de janeiro ou 29 de fevereiro em Brasília, embora já sejam o mês seguinte em UTC.

Os testes acima são reproduzíveis em `test/license-security.test.cjs`, no aplicativo, e em `test/service.test.mjs`, no código do serviço. Seus dados e códigos são de teste e não pertencem às 120 licenças comerciais.

## Falhas encontradas e corrigidas durante a revisão

1. Uma resposta negativa conhecida podia ser esquecida depois de reiniciar sem internet, permitindo carregar um comprovante ativo anterior. A negativa é agora preservada no estado protegido até nova validação autorizada.
2. Um comprovante assinado antigo podia reiniciar a referência de horário. A resposta nova precisa corresponder ao identificador da solicitação atual e ao desafio, além de não regredir a versão/horário assinados anteriormente.
3. A conversão do vencimento para segundos truncava os milissegundos apresentados pelo servidor. O controle utiliza o instante assinado exato, validando sua correspondência ao campo JWT em segundos.
4. Uma interrupção entre salvar no registro e substituir o arquivo podia selecionar uma cópia antiga quando as referências de horário empatavam. O carregamento aplica ordem conservadora, preservando a negativa conhecida.
5. A exceção usada para responder a um administrador depois de vencer poderia ser herdada por outro envio iniciado no mesmo contexto assíncrono. Ela foi limitada ao adaptador, identificador da mensagem, conversa, conteúdo e contexto da resposta administrativa original.
6. Um reinício do computador podia ficar oculto quando o novo tempo de atividade já superava o checkpoint anterior. Com o relógio restaurado, um teste vencido poderia ser reutilizado offline. O checkpoint agora exige o mesmo marcador de inicialização do sistema operacional: no Windows, evento Kernel-General 12 com seu identificador de registro e horário original de boot; no Linux de desenvolvimento, `boot_id`. Marcador diferente, ausente ou indisponível exige validação online e não é legitimado por um salvamento offline. Quatro cenários adicionais reproduzem e verificam essa correção, incluindo a recusa do teste já vencido.

Essas causas foram reproduzidas em testes adversariais antes das correções. Não são alegações sobre incidentes ocorridos no computador do cliente.

## Serviço público, lote administrativo e pacote

O serviço foi publicado em **https://kenned-code-licencas.guilhermekenned.chatgpt.site**, com banco D1 persistente e segredos de assinatura/administrador protegidos na hospedagem. O protocolo foi validado por chamadas HTTPS reais: início de teste de 72 horas, preservação do início, chave inválida, ativação mensal, repetição sem extensão, rejeição em outro dispositivo, renovação anual antecipada, reinício do cliente, disputa concorrente e revogação. Foram usadas somente chaves de teste separadas.

O cadastro oficial foi conferido: **100 mensais e 20 anuais disponíveis, nenhuma ativada**. Os 120 arquivos `.txt`, nomes, planos, pastas, privacidade e conteúdo da planilha foram conferidos no Drive. A planilha é controle manual; editar ou mover arquivos não muda o servidor.

A interface Electron de desenvolvimento foi executada com o cliente real contra esse serviço HTTPS: teste automático, recusa de chave inválida antes do login, ativação mensal de teste, repetição sem acrescentar prazo, plano e vencimento, cadastro local, persistência de modelo, reinício com o mesmo vencimento e nenhuma campanha iniciada automaticamente. O WhatsApp estava em simulação; esse teste não comprova mensagens reais nem instalação física no Windows.

A revisão acrescentou controles para suspensão/relógio regressivo no último ponto de autorização do worker. A ativação aguarda uma validação de conexão em andamento em vez de exigir que o cliente tente novamente sem motivo. O aplicativo usa o transporte seguro nativo do Electron, compatível com a configuração de rede do sistema.

## Pendências de validação física

O ambiente de desenvolvimento é Linux. A instalação física do `.exe`, a identidade Windows obtida do equipamento, a proteção DPAPI e a persistência após reinstalação no Windows do cliente exigem validação nesse sistema. Também permanece separada a validação do recebimento real pelo WhatsApp, que depende de sessão conectada e destinatário de teste autorizado.
