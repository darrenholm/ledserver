-- Cache references to the shop-api project + client created for each paid
-- rental. We can survive without these (the rental is the source of truth)
-- but having them lets staff jump straight from the LED rental view to the
-- job in the projects board.

ALTER TABLE rentals
  ADD COLUMN project_client_id INTEGER,
  ADD COLUMN project_id        INTEGER;

CREATE INDEX rentals_project_idx ON rentals(project_id) WHERE project_id IS NOT NULL;
