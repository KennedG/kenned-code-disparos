# BUSCAS, listas e Excel — versão 2.3.1

Os comandos privados respondem exclusivamente ao solicitante autorizado. Escolher responsáveis para listas ou alertas não redireciona a resposta de outra pessoa. O número particular pode e deve ser diferente do número da loja conectado.

## Comandos privados

Envie ao privado do número conectado da loja:

| Comando | Resultado |
|---|---|
| `!busca iPhone 15 Pro Max 256GB` | Lista de ofertas em texto. |
| `!busca --excel iPhone 15 Pro Max 256GB` | Documento Excel enviado somente ao solicitante. |
| `!busca --ambos iPhone 15 Pro Max 256GB` | Texto e documento Excel enviados somente ao solicitante. |
| `!busca` | Orientação curta e exemplo, sem inventar resultados. |

`--excel` e `--ambos` selecionam o formato e não fazem parte do modelo pesquisado. Se faltar a descrição, inclusive depois desses indicadores, o sistema apresenta orientação. O prefixo é configurável: ao trocar `!busca` por outro prefixo em BUSCAS, use o prefixo salvo nos mesmos exemplos.

Os três formatos usam as mesmas regras de autorização, locais habilitados, filtros, limites por usuário e prevenção de comandos duplicados. O limite de resultados do **comando privado** é o configurado em BUSCAS, inicialmente 10, com máximo de 10. A exportação completa pela interface tem um alcance diferente e inclui todas as páginas.

Pessoas autorizadas somente a pesquisar não recebem controle administrativo. Em conversa privada, administradores autorizados também podem usar:

```text
!mega ajuda
!mega menu
!mega status
!mega parar tudo
!mega retomar sistema
```

`!mega parar tudo` bloqueia envios automáticos e novas entradas até retomada explícita. Os comandos administrativos permanecem disponíveis. Faça o teste da parada somente em ambiente controlado.

## Filtros e período

BUSCAS preserva menor preço, maior preço e oferta mais recente, além de modelo, armazenamento, condição, fornecedor e grupo. A idade máxima padrão é **2 horas**, pela data original da mensagem: uma consulta às 15h considera publicações desde 13h. O período pode ser configurado em minutos ou horas, ou desativado. Preferências anteriores são preservadas; uma instalação já configurada não recebe novos valores por imposição da atualização.

Parcelas, entradas, descontos isolados e preços sem associação segura ao aparelho não são tratados como preço total confirmado. Ofertas sem preço total identificado com segurança não aparecem no ranking como as mais baratas. Informações ausentes não são preenchidas por suposição. Advertências de captura desatualizada ou lacunas acompanham os resultados quando aplicáveis.

## Salvar um Excel no computador

1. Na aba **BUSCAS**, execute a pesquisa e confira filtros e ordenação.
2. Para uma seleção, marque as ofertas desejadas, inclusive em páginas diferentes. Confira o contador.
3. Clique em **Exportar Excel** e escolha **Ofertas selecionadas** ou **Todos os resultados filtrados (todas as páginas)**.
4. Clique em **Salvar Excel** e escolha o destino no computador. A confirmação exige que o arquivo tenha sido efetivamente gerado e gravado.

A exportação completa não usa somente a página visível nem o limite de 10 do comando. Ela percorre o conjunto filtrado da pesquisa e mantém a ordenação. Se uma oferta selecionada tiver sido excluída, alterada ou deixado de corresponder aos filtros, atualize a pesquisa antes de exportar.

O arquivo é um `.xlsx` verdadeiro, com as abas **Ofertas** e **Informações**. Tem cabeçalho destacado, filtros, primeira linha congelada e larguras ajustadas. Inclui modelo, categoria, RAM, armazenamento, cor, condição, bateria, preço, fornecedor, telefones, grupo e data original quando identificados com segurança. Campos não identificados ficam vazios.

Preços são números formatados em reais. Telefones são texto, em colunas distintas para **telefone do remetente** e **contato informado na oferta**. Datas usam o fuso configurado, inicialmente `America/Sao_Paulo`; a aba Informações identifica o fuso, a geração, a busca, os filtros, a ordenação, o alcance e os avisos. Identificadores internos LID/JID não são convertidos em números de telefone.

Limites explícitos: uma planilha comporta até 1.048.575 ofertas além do cabeçalho; o documento aceito pelo fluxo de envio do aplicativo tem limite de 64 MB. Se exceder esses limites, a operação falha com explicação; não trunca resultados silenciosamente. Restrinja os filtros e exporte novamente.

## Enviar listas para responsáveis

1. Reutilize ou cadastre os responsáveis em **Alertas**, com telefone real, país e DDD. Confira se estão ativos e autorizados. O próprio particular pode ser um responsável.
2. Em BUSCAS, clique em **Enviar lista**. Escolha selecionadas ou todos os resultados e o formato: texto, Excel ou ambos.
3. Selecione explicitamente os responsáveis. Confira a prévia com quantidade, filtros, período, formato, destinatários e conteúdo das mensagens. Listas longas indicam a quantidade de partes.
4. Somente **Confirmar e enviar** cria os envios. Preparar a lista ou abrir a prévia não envia mensagens.
5. Acompanhe cada destinatário e cada parte em **Entrega da lista**. Se ofertas ou destinatários mudarem, gere uma nova prévia. A prévia expira após cinco minutos.

O texto é dividido em partes numeradas sem cortar uma oferta pela metade. O Excel é anexado como documento, com nome identificável e legenda. O envio manual exige permissão de gerenciar BUSCAS, além de pesquisar e visualizar; a exportação pela interface exige pesquisar e visualizar. O backend revalida o acesso.

Não há envio automático a fornecedores. Não há publicação nos grupos monitorados por escolher responsáveis. Dados reais e simulados permanecem separados; **SIMULAÇÃO — DADOS FICTÍCIOS** nunca envia para contatos reais.

## Estados e novas tentativas

| Estado | Significado |
|---|---|
| Pendente | Registrado na fila, sem aceitação. |
| Processando | Resolução/validação do destino ou submissão em curso. |
| Enviado — aceito pela integração | Há confirmação de aceitação; ainda não comprova entrega. |
| Entregue / lido | Há recibo correspondente disponibilizado pela integração. |
| Falhou | Motivo/código disponíveis; tentativa controlada somente quando indicada como segura. |
| Resultado incerto | O aplicativo não conseguiu determinar o resultado; revisão obrigatória antes de repetir. |

O Excel gerado fica na biblioteca gerenciada. Enquanto estiver vinculado a um envio pendente, em processamento ou incerto, sua exclusão é bloqueada e informa o vínculo, para não quebrar o envio silenciosamente.

## Verificação que depende do seu WhatsApp

Ainda é necessário conectar a conta real e identificar o número particular de teste autorizado. No celular, confira o retorno das três sintaxes, o destinatário correto e o Excel recebido como documento; abra o arquivo e valide preços numéricos, telefones, datas e filtros. Compare exportações de selecionadas e de todos os resultados, incluindo outras páginas. Teste também ausência de resultados, ajuda sem descrição, bloqueio de não autorizados, alerta de teste, reinicialização e reconexão sem duplicações.

Até essa verificação, testes automatizados e transporte controlado são evidências do código, não prova de recebimento real. Consulte [Atualização e recuperação](ATUALIZACAO-2.3.1.md) para preparar o teste e acompanhar o rastreamento no Diagnóstico.
