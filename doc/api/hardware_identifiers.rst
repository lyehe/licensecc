Customize hardware identifiers
==============================

Change the hardware identification strategy
*************************************************

The library includes IP-address, Ethernet/MAC-address, and disk-serial
strategies. If you want to change the strategy order used for the default
identifier:
  
  - locate the generated ``licensecc_properties.h`` in
    ``build/<preset>/projects/<project-name>/include/licensecc/<project-name>``
    or in the explicitly external ``LCC_PROJECTS_BASE_DIR``; it is not written
    below the source checkout
  - change the strategy lists below; each list is tried in order until the
    first strategy succeeds

.. code-block:: c

   #define LCC_BARE_TO_METAL_STRATEGIES { STRATEGY_DISK, STRATEGY_ETHERNET, STRATEGY_NONE }
   #define LCC_VM_STRATEGIES { STRATEGY_ETHERNET, STRATEGY_NONE }
   #define LCC_LXC_STRATEGIES { STRATEGY_ETHERNET, STRATEGY_NONE }
   #define LCC_DOCKER_STRATEGIES { STRATEGY_NONE }
   #define LCC_CLOUD_STRATEGIES { STRATEGY_NONE }

Implement your own hardware signature generator 
*************************************************

.. doxygenclass:: license::hw_identifier::IdentificationStrategy
