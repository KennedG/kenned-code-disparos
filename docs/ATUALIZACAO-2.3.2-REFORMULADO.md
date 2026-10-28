# Atualização 2.3.2 — reformulado-r1

Esta entrega complementa a base verificada **2.3.2 — Origem da loja** com os controles de [OPORTUNIDADES](OPORTUNIDADES.md), navegação organizada, [Vitrine TV](TV-DE-OFERTAS.md), pausa persistente da captura após excluir uma campanha de origem e bloqueio total após vencimento confirmado da licença. Não acrescenta vendas, caixa, financeiro, custos, margens ou comparação automática de ofertas equivalentes.

## Instalar ou atualizar

1. Pause os envios, use a parada geral quando necessário e encerre o aplicativo pela bandeja. Fechar a janela pode apenas minimizá-lo.
2. Copie **a pasta inteira** `%APPDATA%\Mega Disparos`, incluindo banco, mídias e arquivos do perfil, para uma pasta privada identificada com a data e guarde o instalador anterior. Não misture banco e WAL/SHM de momentos diferentes.
3. Preserve `%LOCALAPPDATA%\KennedCodeDisparos-Licensing` e a âncora `HKCU\Software\KennedCodeDisparos\Licensing`. Não apague, substitua ou transfira essa identidade para outro computador.
4. Instale **Kenned-Code-Disparos-Setup-2.3.2-Reformulado-x64.exe** na mesma pasta dedicada. O instalador conserva o identificador `br.com.megadisparos.desktop` e o perfil legado.
5. Confira licença, usuário, campanhas, contatos, modelos, mídias, responsáveis, ofertas e configurações antes de retomar somente o que deseja executar.

O uso diário não exige Node.js ou terminal. O código completo está em **Kenned-Code-Disparos-Codigo-Fonte-2.3.2-Reformulado.zip**. A revisão interna é **reformulado-r1**, mantendo a versão numérica 2.3.2.

Antes de preparar os novos controles no banco existente, o aplicativo cria e verifica um snapshot SQLite consistente com identificação `2.3.2-reformulado-r1`. Falha nessa cópia impede a preparação da revisão. Esse snapshot cobre somente o banco; não substitui a cópia completa do perfil, das mídias, sessão e identidade da licença.

O backup portátil inclui os controles operacionais de oportunidades. Sua restauração mescla os limites locais, silenciamento, ofertas já enviadas e registros anteriores, sem apagar bloqueios posteriores. O módulo restaurado fica desativado em avaliação; uma tarefa restaurada que estava enviando fica incerta e uma que aguardava fica cancelada. Não há retomada automática.

A cópia integral do perfil conserva a configuração e publicação da TV no banco local, além dos controles da Origem da loja. Não considere o backup portátil de campanhas uma cópia completa da vitrine. Os arquivos cifrados por DPAPI permanecem vinculados ao usuário e equipamento Windows que os protegeram: copiá-los não os transforma em credenciais utilizáveis em outro computador. A identidade de licença e sua âncora externa devem ser conservadas no mesmo dispositivo.

Os artefatos Origem anteriores foram copiados e conferidos por SHA256 antes das alterações. Não contêm o banco particular do usuário. O arquivo de aproximadamente 620 MB informado anteriormente no Drive não pôde ser acessado; sua abertura específica continua pendente.

## Onde encontrar as ferramentas

O menu principal tem **Painel, Campanhas, Origem da loja, Buscas, Grupos, Configurações e Licença**. O botão de recolher o menu conserva ícones e identificação das opções.

**Mais ferramentas** começa recolhido. Ao expandir, as funções existentes aparecem agrupadas por assunto:

- **Atendimento:** OPORTUNIDADES e Contatos.
- **Conteúdo:** Modelos e Biblioteca.
- **Automação:** Alertas e Lembretes.
- **Diagnóstico:** Histórico, Diagnóstico e relatórios de envios.
- **Administração:** Usuários e perfis.

As permissões continuam validadas no backend. Recolher uma ferramenta não altera seu funcionamento nem concede acesso. Relatórios de envios não são relatórios financeiros. O controle de largura recolhe a barra para os ícones principais, com descrição ao passar o mouse. A área de configuração da Vitrine TV fica no **Painel**; a apresentação pública ocupa o aplicativo em tela cheia. Para usar na televisão, coloque a janela nessa tela antes de abrir a vitrine; use **Esc** para sair.

## OPORTUNIDADES

O módulo começa desativado em **avaliação sem envio**. Selecione grupos reais autorizados e campanhas que fornecem as ofertas. Revise modelo, memória, cor, condição, quantidade e disponibilidade; dados ausentes não autorizam uma resposta automática.

Os padrões são 24 horas para a mesma pessoa/procura, 30 minutos entre respostas ao mesmo interessado, três respostas por dia e duas horas de validade contadas da mensagem original. Eventos repetidos e pedidos do mesmo autor em grupos diferentes ficam agrupados com todas as origens. Nome exibido não identifica o autor. Limites, reservas e ofertas já enviadas ficam no SQLite e são reavaliados antes da submissão.

A tela apresenta o subtítulo **Pedidos dos grupos que combinam com seus anúncios**, indicadores de revisão e resultados e cartões com pedido original, interessado, origem, tempo decorrido, oferta compatível e bloqueios. As áreas **Novas**, **Em acompanhamento** e **Encerradas** conservam o histórico; uma oferta enviada não representa uma venda. A imagem e os dados da oferta aparecem somente quando existe uma correspondência identificada com segurança.

No automático, a resposta agrupa as opções e usa uma oferta por padrão. No manual, selecione opções, confira a prévia e confirme. Disponibilidade precisa de atualização válida e referência segura da unidade. Resultado incerto mantém o bloqueio de repetição, libera outras oportunidades elegíveis e exige reconciliação ou revisão com aviso de possível duplicação.

Consulte o [guia completo](OPORTUNIDADES.md) para encerramento ligado à procura, silenciamento, **Já respondi por fora**, sirene agrupada e validação real.

## Origem da loja: exclusão e retomada

Excluir uma campanha vinculada à **Origem da loja** pausa persistentemente a captura daquele grupo. Reiniciar, reconectar, salvar outra configuração ou virar o dia não recria a campanha e não remove essa pausa.

Na aba Origem da loja, escolha **Criar nova campanha e retomar**, **Vincular a uma campanha existente e retomar** ou **Manter importação pausada**. A retomada exige confirmação e usa um rascunho compatível. Somente publicações originais posteriores à retomada são capturadas; itens retirados e campanhas excluídas não reaparecem silenciosamente.

A confirmação de exclusão identifica o grupo vinculado e explica a pausa. O vínculo ativo com o ID excluído é removido na mesma operação; pendências são canceladas. Download em andamento, eventos atrasados, novas tentativas e atualização da tela não recriam a campanha. Se uma mensagem já tiver sido submetida e não puder ser cancelada, o aviso informa essa condição e o controle operacional conserva seu resultado. Referências da TV e de Oportunidades são retiradas dos envios/exibições futuros sem apagar a evidência histórica.

Excluir somente uma publicação retira aquele item dos envios ainda não iniciados; isso não equivale a excluir a campanha. Mensagens já enviadas não são apagadas dos destinatários. Importar um período anterior depende de escolha explícita e dos recursos reais da integração; não é uma recuperação automática do histórico.

## Licença vencida

Quando o serviço ou comprovante confiável confirma o vencimento, o aplicativo mantém somente a tela de licença e o botão de contato com o desenvolvedor. Consulta, edição, exportação, ferramentas e automações ficam bloqueadas. A Vitrine TV mostra um estado neutro e deixa de exibir ofertas.

Os dados continuam salvos. A tela mostra **Sua licença expirou** e **Renove sua licença para continuar utilizando o Kenned Code Disparos. Seus dados estão preservados.** O botão **Falar com o desenvolvedor** abre Guilherme Kenned, **(62) 99403-3173**, em `https://wa.me/5562994033173` somente mediante clique; não envia mensagem automaticamente, não desativa o bloqueio e não altera a licença. Depois de ativar ou renovar, os dados voltam a ficar acessíveis conforme as permissões; a retomada dos envios exige decisão explícita, e a TV precisa ser publicada novamente.

Essa política de acesso e sua apresentação foram alteradas conforme solicitado. Serviço HTTPS, chave pública, cliente criptográfico, vínculo ao dispositivo, prazo contratado e tolerância offline continuam preservados. Atualizar não reinicia o teste, não estende a validade e não consome outra chave. Uma validação anterior pode permitir até **72 horas sem contato com o serviço**, sempre limitada ao vencimento e às verificações de tempo/dispositivo existentes. Falta de conexão e vencimento confirmado são motivos diferentes; leia o código e orientação mostrados em Licença.

## Recuperação da revisão anterior

1. Encerre a revisão atual e guarde outra cópia integral privada para conservar registros posteriores à atualização.
2. Reinstale o instalador anterior compatível com a cópia do banco preparada antes desta revisão, sem abrir o aplicativo ainda. Restaure aquele perfil inteiro; não misture arquivos de instantes diferentes.
3. Preserve a identidade atual da licença e suas âncoras. Não copie uma identidade de outro dispositivo nem use rollback para tentar reiniciar o teste.
4. Abra com automações pausadas, valide a licença e revise as respostas e envios posteriores ao backup antes de retomar.

Restaurar um banco antigo não desfaz mensagens já recebidas. Pode remover do perfil ativo o registro de respostas posteriores ao backup; retomá-las sem revisão pode duplicar mensagens. Guarde o perfil novo para comparar os registros. Não reduza `PRAGMA user_version`, não apague tabelas e não use reset como recuperação.

## Validação e limitações

O relatório final discrimina testes automatizados, integração simulada ou socket controlado, interface com o conteúdo empacotado, aceitação real, entrega confirmada e recebimento no celular. Não é possível concluir os últimos três apenas colocando uma mensagem na fila.

Baileys é não oficial. Captura, PN/LID, histórico, edição/exclusão e recibos dependem da sessão e dos eventos disponibilizados. Sem conta de teste conectada, destinatário autorizado e Windows físico, ficam pendentes captura e resposta reais, notificações/áudio físicos, instalação Windows e identidade DPAPI. A exibição da TV em um equipamento físico também precisa ser conferida. O instalador não tem certificado de assinatura de código.

Valide somente com números e grupos próprios autorizados. Não use clientes ou grupos de produção como destinatários de teste. O aplicativo precisa estar em execução, com internet e sem suspensão, para capturar e enviar; a Vitrine TV local precisa do aplicativo aberto. O manifesto e relatório da revisão devem indicar separadamente o conteúdo realmente verificado no pacote e os testes físicos ainda não executados.
