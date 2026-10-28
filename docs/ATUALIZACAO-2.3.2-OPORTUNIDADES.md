# Atualização 2.3.2 — OPORTUNIDADES

Este guia descreve a introdução de OPORTUNIDADES na **2.3.2 — Origem da loja**. A entrega atual é **reformulado-r1**; use o [guia de atualização reformulada](ATUALIZACAO-2.3.2-REFORMULADO.md) para instalar, ativar e recuperar essa revisão. Não acrescenta vendas, caixa, financeiro ou comparação automática de ofertas equivalentes. O [guia de OPORTUNIDADES](OPORTUNIDADES.md) continua válido para os controles contra respostas repetidas.

## Antes de instalar

1. Pause campanhas e lembretes, ou use a parada geral. Encerre o aplicativo pela bandeja; fechar a janela pode apenas minimizá-lo.
2. Com o aplicativo encerrado, copie **a pasta inteira** `%APPDATA%\Mega Disparos` para uma pasta privada identificada com data e revisão. Guarde o instalador anterior. Não misture banco e arquivos WAL/SHM de momentos diferentes.
3. Preserve também a identidade da licença em `%LOCALAPPDATA%\KennedCodeDisparos-Licensing` e a âncora `HKCU\Software\KennedCodeDisparos\Licensing`. Não apague essa identidade, não a substitua por outra e não a transfira para outro computador.
4. Execute **Kenned-Code-Disparos-Setup-2.3.2-Reformulado-x64.exe** na mesma pasta dedicada. Entre com seu usuário existente e confira licença, campanhas, mídias, responsáveis, grupos reais e preferências antes de retomar.

O instalador conserva `br.com.megadisparos.desktop` e `%APPDATA%\Mega Disparos`. A identificação atual `2.3.2-reformulado-r1` distingue a atualização mesmo mantendo a versão numérica 2.3.2. Antes de preparar os novos controles no banco existente, o aplicativo cria e verifica um snapshot SQLite consistente na pasta `backups`. Uma falha de backup impede a preparação da revisão. O código organizado está em **Kenned-Code-Disparos-Codigo-Fonte-2.3.2-Reformulado.zip**; o uso diário não exige terminal ou Node.js.

Esse snapshot é uma cópia do **banco**. Ele não copia mídias, sessão separada ou identidade da licença. O backup portátil da interface também exclui segredos e não substitui a cópia integral do perfil.

O backup portátil inclui oportunidades, origens, silenciamento, referências de ofertas, tarefas, ofertas já enviadas e registros de notificação. A restauração **mescla** esses controles com os locais e não apaga bloqueios posteriores. Referências de origem conflitantes ou alterações da identidade de uma tarefa são recusadas. Um backup antigo sem a seção OPORTUNIDADES conserva o controle operacional local.

Depois de restaurar, o módulo fica desativado em avaliação: tarefa restaurada que estava enviando fica **incerta**, e tarefa restaurada que estava apenas aguardando fica **cancelada**. Não há retomada automática. Isso difere de simplesmente reiniciar o aplicativo, quando pendências persistentes são reavaliadas antes de qualquer nova submissão.

Na preparação desta entrega, o instalador, código-fonte e guias anteriores foram copiados e conferidos por SHA256 antes das alterações. Esses artefatos permitem recuperar o código anterior, mas **não contêm o banco particular do usuário**. O arquivo de aproximadamente 620 MB informado anteriormente no Drive não foi acessado neste ambiente; sua abertura específica continua pendente.

## O que revisar no primeiro acesso

- O módulo começa com avaliação sem envio para conferir pedidos, correspondências e bloqueios.
- Selecione somente os grupos reais autorizados. O modo de simulação conserva aviso explícito e dados separados.
- Revise as referências das unidades e confirme disponibilidade; atributos e quantidade ausentes não devem liberar resposta automática.
- Confira os controles iniciais: 24 horas para a mesma procura, 30 minutos entre respostas ao contato, três respostas por dia e duas horas de validade do pedido.
- Confira os usuários autorizados, responsáveis, prévia de resposta e configuração de som. Pesquisa não concede controle administrativo.
- Retome somente o que deseja executar. Nenhum teste real deve usar clientes ou grupos de produção.

Os novos registros de deduplicação, agrupamento, ofertas já enviadas, reservas e resultados da resposta são controles operacionais duráveis. Limpar históricos ou uma visualização não deve apagá-los. Encerrar uma oportunidade preserva sua trilha; um resultado incerto não autoriza nova oferta automática.

## Licenças preservadas

O serviço HTTPS, a chave pública, o armazenamento protegido do dispositivo e o cliente criptográfico de licença são conservados em relação ao pacote anterior. A política e interface de acesso foram atualizadas na revisão reformulada: vencimento confirmado mantém somente licença e contato com o desenvolvedor. Instalar esta revisão não reinicia o teste, não acrescenta validade e não consome uma chave nova. Os arquivos administrativos de chaves e as credenciais do servidor não fazem parte do instalador ou do código distribuído.

Se houver falha de validação online, consulte a mensagem específica de licença. Não use restauração de banco, exclusão da âncora ou alteração do relógio para tentar liberar o aplicativo. Recuperar campanhas não altera o estado oficial da licença no servidor.

## Recuperação

1. Encerre a revisão atual e faça outra cópia integral privada, mantendo os registros posteriores à atualização.
2. Reinstale o instalador anterior **compatível com o banco anterior correspondente**, sem abrir o aplicativo ainda. Restaure a cópia completa do perfil preparada antes desta revisão; não misture arquivos de momentos distintos.
3. Preserve a identidade atual da licença e suas âncoras. Não restaure uma identidade de outro dispositivo nem tente reiniciar o teste.
4. Abra com automações pausadas, valide a licença e revise os envios posteriores ao instante do backup antes de retomar qualquer campanha ou resposta.

Restaurar um banco antigo pode remover do perfil ativo a informação de respostas realizadas depois do backup. **Isso não desfaz mensagens já recebidas**, e uma retomada sem revisão pode repeti-las. Guarde o perfil novo e compare os registros operacionais; não use rollback ou limpeza para zerar bloqueios de repetição.

Uma versão que rejeitava uma estrutura incompatível de esquema 8 continuará rejeitando esse banco. Não reduza `PRAGMA user_version`, não apague tabelas e não use reset como recuperação. Se houver apenas o snapshot SQLite, a restauração precisa ser feita com o aplicativo encerrado e com os antigos WAL/SHM separados e preservados; mídias ou sessão ausentes não são recuperadas por esse arquivo.

## Validação e limites

Os testes da entrega devem cobrir variações de texto, origem repetida, concorrência, identidade de pessoas diferentes, mudança relevante, cópia de oferta, unidades diferentes, validade, encerramento, envio incerto, pausa, persistência e limites. O relatório final informa os testes realmente executados e não usa dados simulados como prova de recebimento.

Baileys é não oficial; edição/exclusão, PN/LID, histórico e recibos dependem dos eventos oferecidos pela sessão. Sem conta de teste conectada, número autorizado e Windows físico, ficam pendentes a captura real, resposta recebida, notificação/áudio nativos e execução física do instalador. A configuração está documentada no [roteiro de validação real](OPORTUNIDADES.md#roteiro-de-validação-real).
