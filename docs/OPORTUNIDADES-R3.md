# Oportunidades — revisão R3 da versão 2.3.2

Esta atualização parte da **2.3.2 — recuperação R2**, preservando a identidade do aplicativo e seu perfil existente. Não acrescenta estoque comercial, vendas ou financeiro. As orientações abaixo substituem, nesta revisão, a exigência geral de confirmar novamente a disponibilidade de cada oferta a cada duas horas descrita no guia antigo de Oportunidades.

## Configurar sem enviar por engano

1. Abra **Mais ferramentas → Atendimento → Oportunidades** e habilite somente os grupos reais que deseja acompanhar.
2. Selecione as campanhas que contêm os aparelhos que você realmente pode oferecer. Confira modelo, memória, preço, condições e observações de cada anúncio.
3. Comece em **avaliação sem envio / Somente avisar** para revisar pedidos, correspondências e bloqueios. Selecionar uma campanha não inicia seus disparos e não ativa respostas automáticas.
4. Confira os destinatários e os limites. Para responder automaticamente aos interessados, escolha explicitamente **Resposta automática** e salve. A licença, as permissões, a conexão e a parada geral continuam sendo verificadas antes de cada envio.

## Usar os aparelhos anunciados nas campanhas

O modo padrão usa a **campanha como declaração de disponibilidade feita por você**. Um anúncio válido e habilitado em uma campanha selecionada pode responder a um pedido compatível sem consultar outro sistema de estoque e sem exigir uma confirmação manual a cada duas horas. Isso não é uma conferência física do aparelho nem um cadastro de estoque.

Exemplo: uma pessoa pergunta **“Quem tem iPhone 12 Pro?”** e existe um iPhone 12 Pro válido em uma das campanhas selecionadas. Com o automático habilitado e os demais bloqueios livres, o aplicativo pode enviar essa oferta ao interessado. Um **12 Pro Max** não será enviado como alternativa ao **12 Pro**. Se a pessoa pedir 256 GB, uma oferta de 128 GB não será liberada.

**Retire ou desative o anúncio para Oportunidades assim que deixar de poder oferecer o aparelho.** Abra **Meus anúncios para oportunidades** e use **Retirar das oportunidades**; para voltar a oferecer, revise o aparelho e use **Disponibilizar anúncio**. Campanha ou item removido, publicação de origem excluída, mídia indisponível, aparelho marcado como vendido/reservado/indisponível ou quantidade zero impedem novas respostas. O sistema confere novamente o item da campanha antes da submissão. Um anúncio “sob encomenda” ou “a confirmar” continua exigindo revisão; não vira pronta entrega por estar na campanha.

A opção **Regra avançada de disponibilidade → Exigir confirmação manual recente de cada oferta** permanece disponível para quem deseja registrar confirmações manuais com validade. Nela, o prazo configurado é respeitado. O padrão é **Anúncios disponíveis das minhas campanhas — sem confirmação por prazo**.

Uma referência original ou a identidade persistente do item permite acompanhar a oferta entre tentativas. Reutilizar foto ou texto não comprova que duas unidades físicas sejam a mesma. Cópias conflitantes, listas ambíguas e quantidade desconhecida para pedidos de várias unidades ficam para revisão.

## Reconhecer quem procura de verdade

Pedidos como **“Procuro 12 Pro”**, **“Alguém tem 12 Pro 256?”** e **“12 Pro 256??”** são reconhecidos. O filtro distingue esses pedidos de anúncios como **“Tenho iPhone 12 Pro, alguém quer?”**, perguntas de opinião, conserto, acessórios e mensagens que negam ou encerram a procura.

Casos mistos ou com informação pouco clara ficam para revisão, sem resposta automática. Em **Intenção**, escolha **Procura confirmada**, **Aguardando revisão** ou **Todas as procuras**. Memória, cor, condição, bateria mínima, orçamento e quantidade continuam obrigatórios quando pedidos; características ausentes não são inventadas. Parcela, entrada, desconto ou valor de acessório não substituem o preço total do aparelho.

A validade do **pedido** continua separada da disponibilidade do anúncio: por padrão, uma procura vence duas horas após a mensagem original. Desativar a confirmação periódica da oferta não autoriza responder automaticamente a pedidos vencidos.

## Responder com agilidade e sem repetição

O processamento usa uma fila persistente e reavalia as condições antes do envio. O intervalo configurado entre respostas e os limites por interessado continuam valendo. “Mesmo pedido por 24 horas”, intervalo por contato e limite diário são proteções distintas; diminuir um intervalo não remove as outras.

Eventos repetidos e a mesma procura da mesma pessoa em vários grupos são agrupados. Ofertas anteriores, contato silenciado, pedido expirado, parada geral e tarefas canceladas permanecem bloqueados após reiniciar ou reconectar. A ação **Já respondi** cancela a resposta automática que ainda não começou e registra o atendimento externo.

**Resultado incerto não autoriza outra tentativa automática.** Ele fica registrado para conferência, sem bloquear as demais oportunidades elegíveis. Aceitação pela integração e entrega confirmada são estados diferentes. Se for necessário reenviar manualmente, confira o aviso sobre possível duplicação; a mensagem anterior pode ter chegado.

## Atualizar e recuperar

1. Antes de instalar, pause as automações e use **Configurações → Backup** para guardar uma cópia portátil em local privado.
2. Encerre completamente o aplicativo pela bandeja. Com ele fechado, copie também a pasta inteira **`%APPDATA%\Mega Disparos`**, incluindo banco e mídias. O backup portátil não substitui essa cópia integral nem transfere a sessão ou a licença. Não misture banco e arquivos WAL/SHM de momentos diferentes.
3. Guarde o instalador **2.3.2 — recuperação R2** e a cópia correspondente para recuperação. Preserve a identidade atual da licença em `%LOCALAPPDATA%\KennedCodeDisparos-Licensing` e `HKCU\Software\KennedCodeDisparos\Licensing`; não a apague ou substitua para alterar validade.
4. Instale a revisão R3 na mesma pasta dedicada. Ela mantém o identificador `br.com.megadisparos.desktop` e o perfil existente. Não é necessário apagar dados, baixar o esquema do banco ou usar terminal.
5. Abra, confira campanhas, licença, modelos, grupos e configurações. Revise as campanhas escolhidas em Oportunidades e teste primeiro em avaliação.

Para voltar à R2, encerre a R3 e preserve outra cópia integral do perfil atual antes de reinstalar o instalador guardado. Como a identidade do aplicativo permanece a mesma, não crie outro perfil nem apague o banco. Se for indispensável restaurar a cópia anterior, faça isso com o aplicativo fechado e **revise todos os envios posteriores ao backup antes de retomar**: restaurar dados antigos não desfaz mensagens recebidas nem deve zerar a proteção contra repetição. Não restaure uma identidade de licença de outro dispositivo. A restauração portátil deve ser feita pela opção existente da interface, com os envios pausados.

## O que cada validação comprova

Testes automatizados de intenção e correspondência verificam regras determinísticas, atributos e bloqueios. Testes com transporte controlado verificam fila e tratamento das respostas simuladas da integração. Nenhum deles comprova recebimento no WhatsApp real.

Antes de usar em produção, valide com grupo e número de teste autorizados: pedido capturado, oferta exata, resposta no privado correto, repetição bloqueada, item retirado antes do envio e reconexão sem duplicação. Confira separadamente a aceitação real, o recibo quando disponível e o recebimento no celular. Testar a interface empacotada também não substitui instalar e executar o aplicativo em Windows físico.

A integração Baileys é **não oficial**. O aplicativo e o computador precisam estar em execução, com internet e sessão pronta. Disponibilidade física, permissões do grupo e recebimento efetivo dependem da situação real e devem ser conferidos. O relatório de entrega informa os testes realizados e as validações reais ainda pendentes, sem tratar simulação como envio confirmado.
