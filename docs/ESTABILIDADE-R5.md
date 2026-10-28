# Kenned Code Disparos 2.3.2 — Estabilidade R5

Revisão da entrega Imediato-R4, com a mesma identidade de aplicativo, perfil e licenciamento. Não há mudança de esquema nem módulos de vendas, estoque comercial ou financeiro. Campanhas, contatos, grupos, mídias, modelos, responsáveis, BUSCAS, Origem da loja, lembretes, Oportunidades e Vitrine permanecem preservados.

## Causas comprovadas e correções

1. **Espera circular nas filas.** BUSCAS e alertas obtinham a vez do transporte privado e depois aguardavam o término de toda a campanha. A campanha precisava dessa mesma vez para prosseguir. Agora cada mensagem privada ocupa uma vez limitada da fila compartilhada, sem aguardar a rodada inteira. A campanha continua entre essas mensagens, respeitando o espaçamento. Testes com agendador, SQLite e serviços reais reproduzem a falha na R4 e passam na R5. O transporte usado nesses testes é controlado.
2. **Painel indicava interrupção durante uma rodada normal.** O identificador da rodada pendente e a ausência temporária da próxima execução também são estados normais enquanto se envia. Agora o painel consulta a execução real, mostra “Enviando”, o progresso da rodada e a previsão da próxima rodada quando possível. Sem evidência de interrupção, mostra verificação em vez de inventar uma falha. Clicar novamente em envio imediato da mesma campanha já em execução não reinicia nem duplica a rodada.
3. **Diagnósticos repetidos da mesma tentativa.** Vários observadores registravam o mesmo timeout de BUSCAS. Agora existe um único observador de erro por processamento. Recibos repetidos também deixam de regravar o banco ou atualizar telas; os comprovantes operacionais sobrevivem ao reinício e à limpeza do histórico. Aceitação, entrega e leitura permanecem distintas.
4. **Escolha manual dependia de interpretar o anúncio como oferta automática.** Oportunidades permite “Escolher anúncio” das campanhas habilitadas, mesmo sem correspondência automática ou preço interpretado. A prévia mostra a mídia, legenda original, campanha e destinatário. A confirmação manual não exige estoque nem muda a regra global do automático. Legendas preservam observações e defeitos. Itens retirados, vendidos, excluídos, mídia indisponível, pedido vencido, contato silenciado, parada geral, permissões e bloqueios de duplicidade continuam valendo. O automático mantém correspondência segura; a escolha manual exige revisão explícita.
5. **Campos na legenda.** Cores e saúde de bateria com rótulos usuais passam a ser extraídos sem perder a relação com o aparelho da legenda. Informações ausentes não são inventadas.
6. **Encerramento seguro.** A fila deixa de admitir submissões enquanto o aplicativo encerra. Alertas e buscas ainda não submetidos permanecem pendentes para recuperação, sem classificar o encerramento voluntário como falha de disco.
7. **Aviso criado durante uma fila vazia.** A fila de alertas agora preserva o pedido de processamento ocorrido enquanto a passagem anterior terminava, evitando deixar uma nova ocorrência aguardando desnecessariamente.

Nos registros recebidos houve envios aceitos e lidos durante a rodada apontada como interrompida. Também houve falhas de destinatário `WA_RECIPIENT_MISMATCH`. Os registros antigos não informavam os identificadores suficientes para comprovar a divergência específica. A R5 acrescenta diagnóstico mascarado da resolução; não remove autorização, não inventa telefone a partir de LID e não troca o destinatário silenciosamente. Esse caso precisa ser conferido com a sessão conectada e o telefone real configurado.

## Uso

- Em Campanhas, configure a janela e os intervalos, revise e inicie ou use “Enviar campanha agora”. A contagem continua desde o início autorizado da execução, conforme a R4. Um clique durante a mesma rodada informa que ela já está enviando.
- Em Oportunidades, abra o pedido, clique em “Escolher anúncio”, escolha campanha e item, confira foto/legenda e destinatário na prévia e confirme. Se preferir a seleção automática, continue usando as correspondências compatíveis. Não há consulta a um módulo de estoque.
- Envio aceito não significa entregue. Resultado incerto permanece para revisão e conciliação, sem repetição cega e sem bloquear os demais destinos elegíveis.
- Em caso de falha privada, consulte Diagnóstico pelo identificador da operação. Confira o telefone completo e use o teste de destinatário já existente. Não remova a autorização para contornar uma divergência.

## Atualização e recuperação

1. Pause as automações e faça o backup em Configurações. Feche o aplicativo também pela bandeja.
2. Com o aplicativo fechado, guarde uma cópia completa de `%APPDATA%\Mega Disparos` em local privado. Ela contém dados locais sensíveis e é destinada à recuperação no mesmo computador. O instalador não contém essa pasta, sessões ou chaves administrativas.
3. Execute `Kenned-Code-Disparos-Setup-2.3.2-Estabilidade-x64.exe` na mesma pasta dedicada. Não desinstale apagando o perfil e não exclua o banco ou a licença. A primeira abertura faz as verificações de recuperação já existentes; resultados incertos exigem revisão.
4. Confira licença, conexão e campanhas antes de retomar. Não reative uma campanha só porque a janela antiga exibia uma interrupção. Atualizar não desfaz mensagens já recebidas.

Para recuperar a revisão anterior: feche a R5, guarde uma cópia atual do perfil, reinstale a Imediato-R4 arquivada no Drive e use o perfil compatível. Restaurar um backup antigo sem conferir os envios posteriores pode causar duplicidade; preserve e reconcilie o controle operacional. Backups comuns não transferem a sessão nem a identidade de licença a outro computador. O instalador não possui assinatura comercial de código.

## Validação e limites

Acompanhe `VALIDACAO-ESTABILIDADE-R5.json` e o arquivo de evidências da entrega. São separados testes automatizados, execução real da interface Electron e transporte controlado/simulado. O pacote Windows é verificado por integridade do instalador, dependências e execução do ASAR final em Electron/Linux. Isso não equivale à instalação física no Windows 10/11.

Não havia sessão WhatsApp de teste conectada neste ambiente. Portanto **nenhum envio novo nem recebimento no celular foi validado com WhatsApp real nesta revisão**. Também ficam pendentes a verificação do destinatário que retornou `WA_RECIPIENT_MISMATCH` e o teste físico no Windows. A integração Baileys é não oficial e depende de sessão válida, aplicativo e computador ligados, internet e limites do WhatsApp.

Validação no computador autorizado: publicar foto com legenda no grupo de teste; iniciar uma campanha apenas para destinos de teste; enviar `!busca iPhone 15 Pro Max 256GB` do particular autorizado ao número conectado; gerar um alerta de teste; escolher um anúncio na oportunidade e conferir o recebimento no interessado de teste correto. Nunca usar clientes ou grupos de produção nesses testes. Anotar a operação, resultado da integração e confirmação no celular separadamente.
