# Kenned Code Disparos 2.3.2 · R10 — validação

Data: 30/10/2026. Base preservada: 2.3.2 R9. Aplicativo sem vendas, caixa ou financeiro; sem IA e sem comparação automática de ofertas equivalentes.

**Resultado:** implementação e validação automatizada/controlada concluídas; WhatsApp de produção e instalação física no Windows continuam pendentes. Não houve envio real a clientes, grupos ou ao particular do usuário nesta revisão. Nenhum resultado simulado é apresentado como entrega real.

## O que foi alterado

- Recuperação de conexão com prazo para estados travados, tentativas progressivas e uma única operação concorrente. Botão manual e recuperação automática continuam usando o mesmo serviço e a mesma sessão protegida.
- Antes de anunciar uma sessão pronta, consulta autenticada ao servidor; verificação operacional periódica limitada, sem enviar mensagens de teste. QR, indisponibilidade de rede e desconexão manual continuam distintos. Estatísticas de recuperação persistem por modo, com início do período.
- Conteúdos indecifráveis têm estado pendente, recuperação quando fornecida pela biblioteca, prazo de diagnóstico e contadores. Avisos administrativos são agrupados, sem inventar conteúdo ou repetir comandos antigos.
- Nova fila persistente para contato privado explícito e UPTIME, usando a fila externa já compartilhada pelo agendador. Identidade, licença, permissões, bloqueios e validade são verificados novamente antes da submissão. Resultado incerto libera o próximo trabalho sem reenvio cego; comprovantes tardios são monotônicos.
- **Oportunidades:** ação separada para chamar o participante no privado, com mensagem editável e mídia de correspondência segura, telefone resolvido a partir do participante PN/LID, histórico individual, consulta de incertos e nova tentativa manual com aviso de duplicação. O fluxo existente para os destinos da campanha foi preservado. Não foi habilitado automaticamente um novo disparo privado a todos os participantes.
- **UPTIME:** módulo desativado por padrão, intervalo de 5 minutos a 7 dias, até 20 destinos autorizados, seções configuráveis, teste real do fluxo de fila e histórico por destinatário. Mede o processo host/backend, informa o período dos contadores e não acumula relatórios de todos os intervalos perdidos. `!status` e `!mega status` foram preservados e integrados.
- **Buscas:** pesquisa adicional nas mensagens efetivamente capturadas, com combinação de termos, frases, acentos, nome/telefone disponível, grupo, período, relevância/data e paginação. Interface usa debounce e descarta respostas obsoletas. Uma procura reconhecida pode abrir uma oportunidade para revisão, sem novo contato automático. O ranking estrito de ofertas, preços, janela configurável de duas horas, Excel e comandos existentes permanecem.
- **Campanhas:** rolagem, foco, seleção e rascunho preservados ao voltar do seletor; prévia de mídia leve e substituição mantendo a legenda. Atualizações de fundo evitam reconstruir conteúdo idêntico ou descartar formulários ativos.
- Padrões visuais compartilhados de botões, estados, tabelas e superfícies operacionais; respeito a movimento reduzido. UPTIME permanece dentro de Mais ferramentas, sem aumentar as sete opções principais.
- Banco, perfil, credenciais protegidas, appId e mecanismo de licenciamento preservados. Backup SQLite verificado antes da primeira abertura R10 sobre banco existente. Nenhuma alteração de número do esquema foi necessária.

## Causas comprovadas e limites do diagnóstico

1. **Reconexão travada:** o código anterior excluía estados `connecting` e `connected` da recuperação mesmo quando não havia prontidão. Preparar um socket concluía antes de autenticação/sincronização operacional; não existia esse watchdog. Isso explica um caminho em que o botão forçava nova tentativa e o automático permanecia aguardando. O defeito foi reproduzido com transporte controlado e coberto por testes. Sem a sessão do usuário, não é possível afirmar que essa era a única causa de suas desconexões reais.
2. **Contato privado:** o fluxo R7/R9, conforme o escopo anterior, destinava anúncios aos grupos da campanha. Ele não equivalia a chamar no privado o participante que perguntou. Foi acrescentada uma ação privada separada, com resolução da identidade e estados próprios. Não foi comprovada uma falha geral da biblioteca responsável por todo não recebimento relatado no celular.
3. **Falso sucesso:** a nova ação não considera clique ou fila como envio. Exige identificador e estado de aceitação fornecido pela integração, e reserva entrega/leitura para recibos. Os envios anteriores já possuíam controles de ACK em partes da aplicação; não foram removidos nem substituídos por simulação.
4. **Intervalo após reconexão:** apenas considerar a hora em que uma tarefa entrou na fila permitiria contatos próximos demais após longa espera. O último horário efetivo de submissão é agora revalidado e a tarefa é adiada quando necessário.
5. **Buscas por conteúdo:** a consulta anterior não oferecia a mesma normalização e combinação de termos da nova pesquisa de mensagens. Isso é distinto da busca estruturada de ofertas, que continua exigindo compatibilidade de modelo e preço total.
6. **Editor voltando ao topo:** a reconstrução do modal sempre focava o primeiro campo. A revisão restaura posição, foco e seleção da edição e evita reconstruções idênticas em atualizações de fundo.
7. **“Aguardando mensagem”:** é observável como evento sem conteúdo original decifrado; não existe evidência suficiente para atribuir todas as ocorrências do usuário a uma causa única. O aplicativo não pode fabricar a descriptografia ou obrigar o WhatsApp a fornecer conteúdo ausente.

## Testes executados

| Verificação | Resultado / alcance |
|---|---|
| Suíte completa `node --test --test-concurrency=2 test/*.test.cjs` | **1.457 passaram; zero falhas, zero ignorados.** Inclui os 1.423 casos anteriores e 34 novos. |
| Sintaxe de src/test/scripts | Passou. |
| Recuperação automática/manual, estado travado, QR, desconexão manual, autenticação real do protocolo com socket controlado | Passou; não usa conta WhatsApp real. |
| Identidade PN/LID, vínculo brasileiro comprovado após reconexão, rejeição de divergência e LID sem telefone | Passou com respostas autenticadas controladas; não deriva telefone de LID. |
| Fila, cliques repetidos, timeout, próxima tarefa, recibo tardio, restart, parada geral, licença, revogação e limite de tentativas | Passou. |
| Intervalo efetivo entre privados após reconectar | Passou no backend real com relógio controlado. |
| Mídia gerenciada e legenda no contato privado | Passou com transporte controlado. |
| UPTIME, destinatários autorizados, preferências, intervalos, parada e ausência de acúmulo | Passou. |
| Busca por termos/frase/acentos/contato/grupo/data, paginação, exclusão e isolamento real/simulação | Passou. Ranking de ofertas e exportação anterior também cobertos pela regressão. |
| Backup SQLite anterior à R10, verificação `quick_check` e não repetição após reiniciar | Passou. |
| Electron em desenvolvimento | Passou: formulários/disclosures preservados; UPTIME; busca → oportunidade → privado correto; mídia/rolagem; close/reopen; comandos; navegação nas 15 áreas; janela de 780 px sem transbordamento horizontal global. |
| Electron executando o ASAR final do pacote Windows em Linux | Os mesmos fluxos passaram. Isso **não equivale a instalar/executar o EXE num Windows físico**. |
| Dependências reais do pacote | Importação do adaptador/Baileys e APIs USync, Rust WASM/HKDF e geração binária ExcelJS passaram, sem conectar conta nem enviar mensagens. |
| Integridade da distribuição | Fontes da aplicação comparadas ao ASAR; metadados de versão conferidos; conteúdo do instalador extraído e comparado ao mesmo ASAR testado; CRC de contêineres verificado. |
| Dados administrativos no pacote | Varredura sem banco/sessão do usuário, chaves privadas administrativas ou tokens de GitHub. Fixtures de identificação de aparelhos foram anonimizadas. |

Os logs, manifestos, hashes e capturas acompanham o ZIP de evidências. Aceitações e recibos simulados/controlados não são comprovantes do WhatsApp real.

## Desempenho medido

Carga sintética isolada: **25.000 mensagens SQLite**, 40 consultas, até 30 resultados por página. Inserção em lote: aproximadamente 934 ms neste ambiente Linux.

| Consulta | Média |
|---|---:|
| Termos combinados na janela de duas horas | 67,3 ms |
| Frase, ordenada por data | 56,0 ms |
| Grupo + período | 2,7 ms |
| Contato + período | 67,7 ms |
| Sem correspondência | 110,8 ms |

O heap após coleta foi de cerca de 5,6 para 6,7 MB durante a carga; RSS de cerca de 58 para 209 MB, incluindo memória reservada pelo runtime. Isso não comprova redução global de RAM/CPU nem ausência de vazamentos no uso prolongado. Não foi realizada uma comparação equivalente antes/depois em Windows. O cache de normalização é limitado em memória; a interface não recebe as 25 mil mensagens de uma vez. Medições detalhadas estão no JSON de evidência.

## Pendências reais antes de homologar no ambiente da loja

- Conectar uma sessão WhatsApp de teste autorizada e confirmar manualmente no celular particular os comandos, alertas e a mensagem privada da oportunidade, incluindo mídia. **Envio aceito pela integração real: não executado. Entrega real: não confirmada. Recebimento no celular: não confirmado.**
- Reproduzir a desconexão real, a recuperação com credenciais do usuário e as ocorrências de conteúdo indecifrável; conferir os códigos concretos retornados pela conta.
- Instalar/atualizar/desinstalar o EXE em Windows 10/11, conferir bandeja, notificações, som e proteção DPAPI no equipamento físico. O instalador foi gerado e inspecionado, mas não foi instalado num Windows real aqui. Não tem certificado de assinatura de código.
- Teste prolongado de RAM/CPU com volume e grupos reais da loja e permissão dos participantes. A checagem de layout compacto não transforma o produto em aplicativo Android/iOS.
- A integração Baileys não é oficial. Histórico, identificação de participantes, recuperação criptográfica, recibos de entrega/leitura e acesso a grupos dependem do que o WhatsApp disponibilizar. Não há mecanismos para burlar limites ou restrições.

## Roteiro de homologação sem usar clientes

Com campanhas de produção pausadas, cadastre/valide o particular do dono no usuário e nas autorizações existentes; não há administrador fixo embutido. Use somente grupo e participantes de teste autorizados. Do particular para o número conectado, envie `!status`, `!mega status`, `!busca` e uma busca com modelo conhecido. Confira destinatário, rastreamento e recebimento no celular. Teste um alerta pelo botão, publique um pedido de teste e use **Chamar no privado**. Compare fila, aceitação e eventual recibo com o celular. Execute parada geral por último, em ambiente controlado. Se algo falhar, exporte o rastreio correspondente; não conclua apenas pelo selo da fila.
