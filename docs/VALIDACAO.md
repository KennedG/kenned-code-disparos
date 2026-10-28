# Validação da versão 2.2.0 — Kenned Code Disparos

Ambiente de desenvolvimento: Linux x64, Node.js 24 e Electron 44.5.1. O pacote destina-se a Windows 10/11 x64. Foram aprovados **343 testes automatizados de backend/worker, seis fluxos da fachada desktop e três fluxos de interface no Electron real**. O registro consolidado está em [TESTES-2.2.0.txt](TESTES-2.2.0.txt). Os 292 casos da versão anterior estão documentados separadamente em [VALIDACAO-2.1.0.md](VALIDACAO-2.1.0.md) e não substituem os testes desta versão.

## Regressões específicas desta correção

Os testes aprovados incluem comando manual da própria conta conectada, recepção de pessoa autorizada, autorização recusada, prefixo configurável, busca sem resultados, deduplicação de comandos e rejeição de ecos automáticos persistidos. A identidade da própria conta deve vir dos metadados autenticados, sem confundir `remoteJid` de destino com autor.

Também passaram resolução de destinatários, privado da própria conta, resultado individual de envio, confirmação do servidor e recibos, falha explícita sem fallback de destino, alerta por falha de campanha, falha crítica e desconexão, pendência até reconexão, tentativas limitadas e isolamento do modo simulado.

Os testes de isolamento alternaram modo real/simulado e comprovaram que grupos, campanhas, contatos, ofertas, históricos, seletores e métricas não usam demonstrações como fallback, preservando os registros legítimos e bloqueando submissões do transporte simulado a contatos reais.

## Identidade e preservação do perfil

**Seis fluxos da fachada desktop passaram**, executando o `src/main.cjs` real com APIs nativas substituídas: instância única e fronteira IPC, notificações com retorno explícito, eventos de rede/suspensão/encerramento, manifesto de propriedade, nome Kenned Code Disparos com perfil legado preservado e renderizador real de áudio com ganho/volume.

O teste adicional confirma título da janela, bandeja, Sobre e título padrão da notificação; appId/AUMID estável; seleção do perfil `%APPDATA%\Mega Disparos` antes do mutex; worker apontado ao perfil existente; banco e credenciais preservados; ausência de perfil vazio novo; nomes do pacote/atalho e aceitação da pasta legada no instalador. O teste usa credenciais cifradas por uma fachada local e não comprova DPAPI em Windows físico.

O instalador usa manifesto de propriedade, preserva AppData e arquivos desconhecidos, aceita a pasta dedicada antiga ou nova, troca atalhos conhecidos e migra somente comandos de inicialização criados pelas versões anteriores. A compilação e integridade do artefato são verificações separadas dos fluxos funcionais.

## Limites e pendências reais

**Nenhuma conta WhatsApp real ou máquina Windows física estava disponível neste ambiente.** Não houve leitura real do QR nem envio real ao próprio número, a destinatários ou grupos. Os testes do adaptador utilizam eventos e respostas controlados da biblioteca instalada; não comprovam disponibilidade do serviço, recibos de entrega reais ou permissões da conta.

A instalação/desinstalação em Windows, notificação física na bandeja, permissões do centro de notificações, reprodução/mixer/mudo e entrega real continuam pendentes dessa validação. Nenhum resultado fictício é apresentado como confirmação de transporte real. Um envio de teste ao WhatsApp exige conta conectada e destinatário autorizado pelo usuário; teste de grupo real deve ocorrer somente no grupo indicado.

A integração é **Baileys 7.0.0-rc14 não oficial**. Grupos de comunidades aparecem apenas quando acessíveis à conta; histórico é parcial/oportunista; telefone e eventos de edição/exclusão dependem do que o serviço disponibiliza. LID não é convertido em telefone inventado. Leia [INTEGRACAO.md](INTEGRACAO.md) e [BUSCAS-INTEGRACAO.md](BUSCAS-INTEGRACAO.md).

## Resultado desta execução

- `npm run check`: sintaxe de fontes, testes e scripts aprovada.
- `npm test`: 343/343 casos Node.js passaram, sem falhas, pulos ou testes pendentes; mais seis fluxos desktop aprovados.
- `scripts/smoke-ui.cjs`: interface, dono/login, criação/ativação/parada de campanha, permissões, biblioteca gerenciada, temas, volume e limpeza com auditoria e ledger preservado.
- `scripts/smoke-searches-ui.cjs`: configuração/prefixo/grupos independentes, captura, ranking sem parcelas, entrega privada, orientação sem descrição, revisão e limpezas separadas.
- `scripts/smoke-fixes-ui.cjs`: própria conta com `fromMe`, ausência de ofertas e resposta única, destinatário responsável salvo, teste por destinatário, teste de alerta offline, pendência até reconexão com horário original e confirmação individual, modo real vazio e retorno à simulação preservando dados.
- `test/audit-self-delivery.test.cjs`: seis testes de ponta a ponta com SQLite e os serviços reais, usando socket Baileys controlado. Cobrem identificação própria com dispositivo, número autorizado, resultado e destino privado, eco persistente após reinício, desconexão/erro e fila compartilhada sem sobrepor transportes.

Os fluxos de interface executaram o aplicativo Electron e o worker efetivo com SQLite, em Linux. As mensagens e os recibos são simulados e identificados; **nenhuma confirmação de conta real foi obtida**. Não confundir estes testes com entrega real ao WhatsApp ou verificação física do Windows.

A compilação NSIS produz `Kenned-Code-Disparos-Setup-2.2.0-x64.exe`. Na distribuição, a integridade do contêiner NSIS e do payload 7z, o executável PE x64, o manifesto de propriedade e a correspondência das fontes com `app.asar` são conferidos separadamente. O artefato é destinado ao Windows 10/11 x64 e não possui assinatura de código.
